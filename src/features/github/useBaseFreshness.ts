import { useEffect, useState } from 'react'
import type { Repo } from '../../db/schema'
import { gitService } from '../../git/client'
import { connect } from '../../github/connect'
import { errorMessage } from '../../github/errors'
import { checkFreshness, type Freshness } from '../../github/freshness'
import { pushedAncestor, type PushedAncestor } from '../../github/pushedBase'

export type FreshnessState =
  | { status: 'off' }
  | { status: 'checking' }
  | { status: 'error'; message: string }
  /** `pushed` is HEAD's nearest ancestor on GitHub, looked up when the base is stale and HEAD is not pushed. */
  | { status: 'done'; freshness: Freshness; localTip: string; pushed: PushedAncestor | null }

const ancestors = new Map<string, Promise<PushedAncestor>>()

/** Compares local origin/<base> with GitHub once the repo is open (`ready`), and again on each `refreshKey`. */
export function useBaseFreshness(repo: Repo, ready: boolean, refreshKey: number): FreshnessState {
  const [state, setState] = useState<FreshnessState>({ status: 'off' })
  const { owner, name, baseBranch } = repo

  useEffect(() => {
    if (!ready || !baseBranch) return
    let cancelled = false
    const run = async () => {
      const conn = await connect({ owner, name })
      if (cancelled) return
      if (!conn) return setState({ status: 'off' })
      setState((current) => (current.status === 'done' ? current : { status: 'checking' }))
      const git = gitService()
      const [base, info] = await Promise.all([git.resolveBase(baseBranch), git.info()])
      const freshness = await checkFreshness(conn.gh, conn.ref, {
        baseBranch,
        localTip: base.baseTipSha,
        headSha: info.headSha,
      })
      let pushed: PushedAncestor | null = null
      if (freshness.kind === 'stale' && !freshness.headPushed) {
        const key = `${owner}/${name}@${info.headSha}:${baseBranch}`
        let lookup = ancestors.get(key)
        if (!lookup) {
          lookup = pushedAncestor(conn.gh, conn.ref, git, baseBranch)
          ancestors.set(key, lookup)
          lookup.catch(() => ancestors.delete(key))
        }
        pushed = await lookup
      }
      if (!cancelled) setState({ status: 'done', freshness, localTip: base.baseTipSha, pushed })
    }
    run().catch((error: unknown) => !cancelled && setState({ status: 'error', message: errorMessage(error) }))
    return () => {
      cancelled = true
    }
  }, [owner, name, baseBranch, ready, refreshKey])

  return state
}
