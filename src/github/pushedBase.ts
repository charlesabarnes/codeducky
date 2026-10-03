import type { GitHubClient } from './client'
import { githubMergeBase } from './freshness'
import type { RepoRef } from './types'

/** How far back HEAD's first-parent chain is checked for a commit GitHub knows. */
export const ANCESTOR_LIMIT = 50
const BATCH = 10

/** The slice of the git worker that finding a GitHub base needs. */
export interface AncestryGit {
  firstParents(limit: number): Promise<string[]>
  resolveBase(baseBranch: string): Promise<{ mergeBaseSha: string }>
}

export interface PushedAncestor {
  headSha: string
  sha: string
  /** True when the commit came from the local merge base fallback rather than the ancestry walk. */
  fallback: boolean
}

/**
 * The nearest commit on HEAD's first-parent chain that exists on GitHub (HEAD itself when it is pushed).
 * Checks at most ANCESTOR_LIMIT commits, BATCH at a time; past that, the local merge base with
 * origin/<base> is used, which is on GitHub whenever it was fetched from there.
 */
export async function pushedAncestor(gh: GitHubClient, ref: RepoRef, git: AncestryGit, baseBranch: string): Promise<PushedAncestor> {
  const chain = await git.firstParents(ANCESTOR_LIMIT)
  const headSha = chain[0]
  if (!headSha) throw new Error('HEAD has no commits.')
  // HEAD alone first, since it is usually pushed; then the rest a batch at a time.
  for (let i = 0; i < chain.length; i += i === 0 ? 1 : BATCH) {
    const batch = chain.slice(i, i === 0 ? 1 : i + BATCH)
    const known = await Promise.all(batch.map((sha) => gh.commitExists(ref, sha)))
    const found = known.indexOf(true)
    if (found >= 0) return { headSha, sha: batch[found]!, fallback: false }
  }
  return { headSha, sha: (await git.resolveBase(baseBranch)).mergeBaseSha, fallback: true }
}

export interface GitHubBase {
  headSha: string
  baseSha: string
  githubBase: { branch: string; tipSha: string; pushedSha?: string }
}

/**
 * The merge base of the GitHub base tip and HEAD, via the nearest pushed ancestor of HEAD.
 * `pushedSha` is set when that is not HEAD, so the UI can say which commit was used.
 */
export async function findGitHubBase(
  gh: GitHubClient,
  ref: RepoRef,
  git: AncestryGit,
  input: { baseBranch: string; remoteTip?: string },
): Promise<GitHubBase> {
  const remoteTip = input.remoteTip ?? (await gh.branchHead(ref, input.baseBranch))
  if (!remoteTip) throw new Error(`GitHub has no branch named ${input.baseBranch}.`)
  const ancestor = await pushedAncestor(gh, ref, git, input.baseBranch)
  const baseSha = await githubMergeBase(gh, ref, remoteTip, ancestor.sha)
  const githubBase = { branch: input.baseBranch, tipSha: remoteTip }
  const { headSha, sha } = ancestor
  return { headSha, baseSha, githubBase: sha === headSha ? githubBase : { ...githubBase, pushedSha: sha } }
}
