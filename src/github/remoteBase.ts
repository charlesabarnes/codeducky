import type { FileChange } from '../git/types'
import type { GitHubClient } from './client'
import type { RepoRef } from './types'

/** The slice of the git worker that diffing against a GitHub base needs. */
export interface BaseGit {
  hasCommit(sha: string): Promise<boolean>
  changes(baseCommit: string): Promise<FileChange[]>
  changesAgainstOids(base: Record<string, string>): Promise<FileChange[]>
  missingBlobs(oids: string[]): Promise<string[]>
  addBlobs(blobs: Record<string, Uint8Array>): unknown
}

const FETCH_CONCURRENCY = 6
const trees = new Map<string, Promise<Record<string, string>>>()
const blobs = new Map<string, Promise<Uint8Array>>()

async function treeOids(gh: GitHubClient, ref: RepoRef, sha: string): Promise<Record<string, string>> {
  const tree = await gh.tree(ref, sha)
  if (tree.truncated) {
    throw new Error('The base tree is too large for the GitHub API to list. Fetch the base branch locally instead.')
  }
  const oids: Record<string, string> = {}
  for (const entry of tree.entries) if (entry.type === 'blob') oids[entry.path] = entry.sha
  return oids
}

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let value = cache.get(key)
  if (!value) {
    value = load()
    cache.set(key, value)
    value.catch(() => cache.delete(key))
  }
  return value
}

async function fetchBlobs(gh: GitHubClient, ref: RepoRef, oids: string[]): Promise<Record<string, Uint8Array>> {
  const result: Record<string, Uint8Array> = {}
  const queue = [...oids]
  const worker = async () => {
    for (let oid = queue.shift(); oid; oid = queue.shift()) {
      const key = oid
      result[key] = await cached(blobs, key, () => gh.blob(ref, key))
    }
  }
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker))
  return result
}

/**
 * Lists working-tree changes against a merge base found through the GitHub API.
 * The commit is usually already local (it is an ancestor of HEAD); when it is not, its tree comes from GitHub.
 * Either way, only the old-side blobs of changed paths that are missing locally are downloaded.
 */
export async function githubBaseChanges(git: BaseGit, gh: GitHubClient, ref: RepoRef, baseSha: string): Promise<FileChange[]> {
  const changes = (await git.hasCommit(baseSha))
    ? await git.changes(baseSha)
    : await git.changesAgainstOids(await cached(trees, `${ref.owner}/${ref.name}@${baseSha}`, () => treeOids(gh, ref, baseSha)))
  const oldOids = changes.flatMap((change) => (change.oldOid ? [change.oldOid] : []))
  const missing = await git.missingBlobs(oldOids)
  if (missing.length > 0) await git.addBlobs(await fetchBlobs(gh, ref, missing))
  return changes
}
