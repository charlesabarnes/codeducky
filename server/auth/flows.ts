import type { Database } from 'bun:sqlite'
import { timingSafeEqual } from 'node:crypto'
import { hashToken } from './passphrase'
import { randomSecret, verifierMatches } from './pkce'

export const FLOW_TTL_MS = 10 * 60_000
export const HANDOFF_TTL_MS = 60_000

export type FlowPurpose = 'pwa' | 'oauth'

/** One GitHub round-trip, tied to the browser that started it by the flow cookie. */
export interface AuthFlow {
  purpose: FlowPurpose
  githubVerifier: string
  pwaChallenge: string | null
  oauthRequest: string | null
  expiresAt: number
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
  const prune = () => {
    db.query('DELETE FROM auth_flows WHERE expires_at <= ?').run(now())
    db.query('DELETE FROM auth_handoffs WHERE expires_at <= ?').run(now())
  }

  return {
    start(options: { purpose: 'pwa'; pwaChallenge: string } | { purpose: 'oauth'; oauthRequest: string }): StartedFlow {
      prune()
      const flow = { flowId: randomSecret(), state: randomSecret(), githubVerifier: randomSecret() }
      db.query(
        `INSERT INTO auth_flows (id_hash, state_hash, purpose, github_verifier, pwa_challenge, oauth_request, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        hashToken(flow.flowId),
        hashToken(flow.state),
        options.purpose,
        flow.githubVerifier,
        options.purpose === 'pwa' ? options.pwaChallenge : null,
        options.purpose === 'oauth' ? options.oauthRequest : null,
        now(),
        now() + FLOW_TTL_MS,
      )
      return flow
    },

    /** Single use: the flow is deleted whether or not the state matches. */
    take(flowId: string, state: string): AuthFlow | null {
      const row = db
        .query<FlowRow, [string]>(
          'DELETE FROM auth_flows WHERE id_hash = ? RETURNING state_hash, purpose, github_verifier, pwa_challenge, oauth_request, expires_at',
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
