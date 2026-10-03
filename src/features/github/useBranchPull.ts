import { useEffect, useState } from 'react'
import { db } from '../../db/db'
import type { Repo, Session } from '../../db/schema'
import { connect } from '../../github/connect'
import type { PullRequest } from '../../github/types'

const lookups = new Map<string, Promise<PullRequest | null>>()

/**
 * The open pull request whose head is a local session's branch, if a token is set. It is recorded
 * on the session (as `pr`), so the pre-push gate and MCP can link to it.
 */
export function useBranchPull(session: Session, repo: Pick<Repo, 'owner' | 'name'>, enabled: boolean): PullRequest | null {
  const [pull, setPull] = useState<PullRequest | null>(null)
  const { owner, name } = repo
  const { branch, id } = session
  const recorded = session.pr?.number
  useEffect(() => {
    if (!enabled || !owner || !name) return
    let cancelled = false
    const key = `${owner}/${name}:${branch}`
    const run = async () => {
      const conn = await connect({ owner, name })
      if (!conn) return
      let lookup = lookups.get(key)
      if (!lookup) {
        lookup = conn.gh.openPullForBranch(conn.ref, branch)
        lookups.set(key, lookup)
        lookup.catch(() => lookups.delete(key))
      }
      const found = await lookup
      if (cancelled) return
      setPull(found)
      if (found && id && recorded !== found.number) {
        await db.sessions.update(id, { pr: { owner, name, number: found.number, title: found.title, url: found.htmlUrl, baseRef: found.baseRef } })
      }
    }
    run().catch((error: unknown) => console.warn('Could not look up the pull request for this branch', error))
    return () => {
      cancelled = true
    }
  }, [enabled, owner, name, branch, id, recorded])
  return pull
}
