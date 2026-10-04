import { useEffect, useState } from 'react'
import { gitService } from '../../git/client'
import type { BranchCommit } from '../../git/types'
import type { GitHubClient } from '../../github/client'
import { errorMessage } from '../../github/errors'
import type { RepoRef } from '../../github/types'

export type CommitsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; commits: BranchCommit[]; truncated: boolean }

/** GitHub lists at most this many commits of a pull request. */
const PR_COMMIT_LIMIT = 250

export type CommitsOrigin =
  | { kind: 'local'; baseSha: string }
  | { kind: 'pr'; gh: GitHubClient; ref: RepoRef; number: number; head: string }

async function loadCommits(origin: CommitsOrigin): Promise<{ commits: BranchCommit[]; truncated: boolean }> {
  if (origin.kind === 'local') return gitService().branchCommits(origin.baseSha)
  const commits = await origin.gh.pullCommits(origin.ref, origin.number)
  return { commits, truncated: commits.length >= PR_COMMIT_LIMIT }
}

/**
 * The branch's commits for the picker, oldest first: the local merge base..HEAD through the git worker (once the
 * session's scan has opened the repo), or the pull request's commits from the API. Reloads when `key` changes.
 */
export function useBranchCommits(origin: CommitsOrigin, ready: boolean, key: string): CommitsState {
  const [state, setState] = useState<{ key: string; value: CommitsState } | null>(null)
  const originKey = origin.kind === 'local' ? `local:${origin.baseSha}` : `pr:${origin.ref.owner}/${origin.ref.name}#${origin.number}@${origin.head}`
  const fullKey = `${originKey}:${key}`
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    loadCommits(origin)
      .then((loaded) => !cancelled && setState({ key: fullKey, value: { status: 'ready', ...loaded } }))
      .catch((error: unknown) => !cancelled && setState({ key: fullKey, value: { status: 'error', message: errorMessage(error) } }))
    return () => {
      cancelled = true
    }
    // origin is rebuilt every render; fullKey covers what matters in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullKey, ready])
  // A reload keeps showing the last list; picks are held by sha, so they survive it.
  return state?.value ?? { status: 'loading' }
}
