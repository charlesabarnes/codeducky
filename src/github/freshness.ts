import type { GitHubClient } from './client'
import type { RepoRef } from './types'

export type Freshness =
  /** Local origin/<base> matches GitHub. */
  | { kind: 'fresh'; remoteTip: string }
  /** GitHub has no branch by that name. */
  | { kind: 'no-remote-branch' }
  /** Local origin/<base> differs from GitHub. `headPushed` says whether GitHub knows the local HEAD commit. */
  | { kind: 'stale'; localTip: string; remoteTip: string; headPushed: boolean }

export interface FreshnessInput {
  baseBranch: string
  localTip: string
  headSha: string
}

export async function checkFreshness(gh: GitHubClient, ref: RepoRef, input: FreshnessInput): Promise<Freshness> {
  const remoteTip = await gh.branchHead(ref, input.baseBranch)
  if (!remoteTip) return { kind: 'no-remote-branch' }
  if (remoteTip === input.localTip) return { kind: 'fresh', remoteTip }
  const headPushed = await gh.commitExists(ref, input.headSha)
  return { kind: 'stale', localTip: input.localTip, remoteTip, headPushed }
}

/** The merge base of the GitHub base tip and the local HEAD, which must already be on GitHub. */
export async function githubMergeBase(gh: GitHubClient, ref: RepoRef, remoteTip: string, headSha: string): Promise<string> {
  return (await gh.compare(ref, remoteTip, headSha)).mergeBaseSha
}
