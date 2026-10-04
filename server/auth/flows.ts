import type { Database } from 'bun:sqlite'
import { timingSafeEqual } from 'node:crypto'
import { hashToken } from './passphrase'
import { randomSecret, verifierMatches } from './pkce'

export const FLOW_TTL_MS = 10 * 60_000
export const HANDOFF_TTL_MS = 60_000
/** Flows are created before anyone signs in, so their number is capped in total and per address. */
export const MAX_FLOWS = 10_000
export const MAX_FLOWS_PER_IP = 10

export class FlowLimitError extends Error {}

export type FlowPurpose = 'pwa' | 'oauth'

/** One GitHub round-trip, tied to the browser that started it by the flow cookie. */
export interface AuthFlow {
  purpose: FlowPurpose
  githubVerifier: string
  pwaChallenge: string | null
  oauthRequest: string | null
  expiresAt: number
}

/** A signed-in user's pending MCP consent: the page carries `flow` and `ticket`, the server keeps the request. */
export interface ConsentTicket {
  flow: string
  ticket: string
}

export interface PendingConsent {
  oauthRequest: string
  userId: string
}

export interface StartedFlow {
  /** The flow cookie value; only its hash is stored. */
  flowId: string
  state: string
  githubVerifier: string
}

interface FlowRow {
  state_hash: string
  purpose: FlowPurpose
  github_verifier: string
  pwa_challenge: string | null
  oauth_request: string | null
  expires_at: number
}

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export function createFlowStore(db: Database, now: () => number = Date.now) {
  /** The flows each client address started, oldest first; kept in memory, so a restart forgets them. */
  const byIp = new Map<string, { idHash: string; expiresAt: number }[]>()

  const prune = () => {
    db.query('DELETE FROM auth_flows WHERE expires_at <= ?').run(now())
    db.query('DELETE FROM auth_handoffs WHERE expires_at <= ?').run(now())
    for (const [ip, started] of byIp) {
      const live = started.filter((flow) => flow.expiresAt > now())
      if (live.length) byIp.set(ip, live)
      else byIp.delete(ip)
    }
  }

  const count = () => db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM auth_flows').get()!.n

  /** Drops the oldest flow that has not reached consent; a signed-in user's pending consent is kept. */
  const evictOldest = (): boolean => {
    const row = db
      .query<{ id_hash: string }, []>(
        `DELETE FROM auth_flows WHERE id_hash =
           (SELECT id_hash FROM auth_flows WHERE consent_hash IS NULL ORDER BY created_at, rowid LIMIT 1)
         RETURNING id_hash`,
      )
      .get()
    if (!row) return false
    for (const [ip, started] of byIp) {
      const index = started.findIndex((flow) => flow.idHash === row.id_hash)
      if (index < 0) continue
      started.splice(index, 1)
      if (!started.length) byIp.delete(ip)
      break
    }
    return true
  }

  return {
    /**
     * Past the per-address cap the address's oldest flow is dropped, so a client can always retry;
     * past the total cap, the oldest flow overall. Throws FlowLimitError only when every slot holds
     * a pending consent.
     */
    start(options: { purpose: 'pwa'; pwaChallenge: string } | { purpose: 'oauth'; oauthRequest: string }, ip: string): StartedFlow {
      prune()
      const started = byIp.get(ip) ?? []
      while (started.length >= MAX_FLOWS_PER_IP) db.query('DELETE FROM auth_flows WHERE id_hash = ?').run(started.shift()!.idHash)
      while (count() >= MAX_FLOWS) if (!evictOldest()) throw new FlowLimitError()
      const flow = { flowId: randomSecret(), state: randomSecret(), githubVerifier: randomSecret() }
      const idHash = hashToken(flow.flowId)
      db.query(
        `INSERT INTO auth_flows (id_hash, state_hash, purpose, github_verifier, pwa_challenge, oauth_request, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        idHash,
        hashToken(flow.state),
        options.purpose,
        flow.githubVerifier,
        options.purpose === 'pwa' ? options.pwaChallenge : null,
        options.purpose === 'oauth' ? options.oauthRequest : null,
        now(),
        now() + FLOW_TTL_MS,
      )
      started.push({ idHash, expiresAt: now() + FLOW_TTL_MS })
      byIp.set(ip, started)
      return flow
    },

    /** Single use: the flow is deleted whether or not the state matches. */
    take(flowId: string, state: string): AuthFlow | null {
      const row = db
        .query<FlowRow, [string]>(
          'DELETE FROM auth_flows WHERE id_hash = ? AND consent_hash IS NULL RETURNING state_hash, purpose, github_verifier, pwa_challenge, oauth_request, expires_at',
        )
        .get(hashToken(flowId))
      if (!row || row.expires_at <= now() || !sameHash(row.state_hash, hashToken(state))) return null
      return {
        purpose: row.purpose,
        githubVerifier: row.github_verifier,
        pwaChallenge: row.pwa_challenge,
        oauthRequest: row.oauth_request,
        expiresAt: row.expires_at,
      }
    },

    /**
     * After GitHub sign-in for MCP consent: keeps the request server-side under a new flow id, bound
     * to the user, with a one-time ticket for the consent form. The state is random and never sent.
     */
    awaitConsent(oauthRequest: string, userId: string): ConsentTicket {
      const consent = { flow: randomSecret(), ticket: randomSecret() }
      db.query(
        `INSERT INTO auth_flows (id_hash, state_hash, purpose, github_verifier, oauth_request, user_id, consent_hash, created_at, expires_at)
         VALUES (?, ?, 'oauth', '', ?, ?, ?, ?, ?)`,
      ).run(hashToken(consent.flow), hashToken(randomSecret()), oauthRequest, userId, hashToken(consent.ticket), now(), now() + FLOW_TTL_MS)
      return consent
    },

    /** Single use: a wrong ticket burns the flow too. */
    takeConsent(flow: string, ticket: string): PendingConsent | null {
      const row = db
        .query<{ consent_hash: string; oauth_request: string; user_id: string; expires_at: number }, [string]>(
          `DELETE FROM auth_flows WHERE id_hash = ? AND consent_hash IS NOT NULL
           RETURNING consent_hash, oauth_request, user_id, expires_at`,
        )
        .get(hashToken(flow))
      if (!row || row.expires_at <= now() || !sameHash(row.consent_hash, hashToken(ticket))) return null
      return { oauthRequest: row.oauth_request, userId: row.user_id }
    },

    /** A one-time code the PWA swaps for a session, bound to the challenge it sent at the start. */
    createHandoff(userId: string, challenge: string): string {
      const code = randomSecret()
      db.query('INSERT INTO auth_handoffs (code_hash, user_id, challenge, expires_at) VALUES (?, ?, ?, ?)').run(
        hashToken(code),
        userId,
        challenge,
        now() + HANDOFF_TTL_MS,
      )
      return code
    },

    /** Single use: a wrong verifier burns the code too. Returns the user id, or null. */
    consumeHandoff(code: string, verifier: unknown): string | null {
      const row = db
        .query<{ user_id: string; challenge: string; expires_at: number }, [string]>(
          'DELETE FROM auth_handoffs WHERE code_hash = ? RETURNING user_id, challenge, expires_at',
        )
        .get(hashToken(code))
      if (!row || row.expires_at <= now() || !verifierMatches(verifier, row.challenge)) return null
      return row.user_id
    },
  }
}

export type FlowStore = ReturnType<typeof createFlowStore>
