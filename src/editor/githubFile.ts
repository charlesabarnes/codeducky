import type { GitHubClient } from '../github/client'
import { isGitHubError } from '../github/errors'
import type { PullDetail, RepoRef } from '../github/types'
import { encodeText, type TextFormat } from './textFormat'

/** Where saving a pull request's file commits to: its head branch, in the fork for fork PRs. */
export interface PrEditTarget {
  repo: RepoRef
  branch: string
}

export type PrAccess = { kind: 'ok'; target: PrEditTarget } | { kind: 'blocked'; reason: string }

export type CommitResult =
  | { kind: 'committed'; commitSha: string; blobSha: string }
  /** The file on the branch is not the blob the edits started from: reload and edit again. */
  | { kind: 'conflict'; message: string }
  /** The token cannot write to the repository. */
  | { kind: 'forbidden'; message: string }

const label = (repo: RepoRef) => `${repo.owner}/${repo.name}`
const sameRepo = (a: RepoRef, b: RepoRef) => label(a).toLowerCase() === label(b).toLowerCase()
const blocked = (reason: string): PrAccess => ({ kind: 'blocked', reason })

export const defaultCommitMessage = (path: string) => `Update ${path}`

export function headRepoRef(pull: Pick<PullDetail, 'headRepo'>): RepoRef | null {
  const [owner, name, ...rest] = pull.headRepo?.split('/') ?? []
  return owner && name && rest.length === 0 ? { owner, name } : null
}

async function canPush(gh: GitHubClient, repo: RepoRef): Promise<boolean | null> {
  try {
    return (await gh.repo(repo)).canPush
  } catch (error) {
    if (isGitHubError(error, 'not-found')) return false
    throw error
  }
}

/** Whether the token's user can commit to the pull request's head branch, and where. Unknown access counts as allowed. */
export async function prEditAccess(gh: GitHubClient, base: RepoRef, pull: PullDetail): Promise<PrAccess> {
  if (pull.state !== 'open') return blocked(`This pull request is ${pull.state}, so its branch takes no commits from here.`)
  const head = headRepoRef(pull)
  if (!head) return blocked('The fork this pull request came from was deleted, so there is no branch to commit to.')
  const target = { repo: head, branch: pull.headRef }
  if (sameRepo(head, base)) {
    return (await canPush(gh, base)) === false ? blocked(`You cannot push to ${label(base)}, so saving is off.`) : { kind: 'ok', target }
  }
  if ((await canPush(gh, head)) !== false) return { kind: 'ok', target }
  if (pull.maintainerCanModify && (await canPush(gh, base)) !== false) return { kind: 'ok', target }
  return blocked(
    `This pull request comes from the fork ${label(head)}, which you cannot push to` +
      (pull.maintainerCanModify ? '.' : ', and its author has not allowed edits by maintainers.') +
      ' Saving is off.',
  )
}

export const permissionMessage = (repo: RepoRef) =>
  `GitHub refused the commit: the token cannot write to ${label(repo)}. A fine-grained token needs Contents: read and write ` +
  'on this repository (a classic token needs the repo scope). Update it in Settings, then save again.'

/** Commits the text to the head branch, replacing the blob `sha`; GitHub refuses when the branch has a newer one. */
export async function commitFile(
  gh: GitHubClient,
  target: PrEditTarget,
  path: string,
  edit: { text: string; format: TextFormat; sha: string; message: string },
): Promise<CommitResult> {
  try {
    const result = await gh.putFile(target.repo, path, {
      branch: target.branch,
      message: edit.message,
      content: encodeText(edit.text, edit.format),
      sha: edit.sha,
    })
    return { kind: 'committed', ...result }
  } catch (error) {
    if (!isGitHubError(error)) throw error
    // 409 is a stale blob sha; a 422 only when GitHub names the sha (other 422s are validation errors).
    if (error.status === 409 || (error.status === 422 && /\bsha\b/i.test(error.message))) {
      return {
        kind: 'conflict',
        message: `${path} changed on ${target.branch} since you opened it, so GitHub refused the commit (${error.status}). Reload to get the branch's version.`,
      }
    }
    if (error.kind === 'forbidden' || error.kind === 'not-found') return { kind: 'forbidden', message: permissionMessage(target.repo) }
    throw error
  }
}
