import git, { type WalkerEntry } from 'isomorphic-git'
import { readOldBytes } from './contents'
import type { GitContext } from './context'
import { hashBlob } from './hash'
import { toSide, DEFAULT_MAX_BYTES } from './sides'
import type { BranchCommit, FileChange, FileContents, HeadMove } from './types'

/** The picker lists at most this many commits. */
export const MAX_BRANCH_COMMITS = 300
/** How far back from the base the stop set reaches, for branches that merged the base in. */
const BASE_ANCESTRY_LIMIT = 5000

async function headSha({ fs, dir, gitdir }: GitContext): Promise<string> {
  return git.resolveRef({ fs, dir, gitdir, ref: 'HEAD' })
}

/** The base and its ancestors (breadth first, bounded): first-parent walks from HEAD stop at any of them. */
async function baseAncestry(ctx: GitContext, baseSha: string, limit = BASE_ANCESTRY_LIMIT): Promise<Set<string>> {
  const { fs, dir, gitdir, cache } = ctx
  const seen = new Set<string>([baseSha])
  const queue = [baseSha]
  while (queue.length && seen.size < limit) {
    const oid = queue.shift()!
    let parents: string[]
    try {
      parents = (await git.readCommit({ fs, dir, gitdir, cache, oid })).commit.parent
    } catch {
      continue
    }
    for (const parent of parents) {
      if (seen.has(parent)) continue
      seen.add(parent)
      queue.push(parent)
    }
  }
  return seen
}

/**
 * The branch's commits: HEAD's first parents back to the merge base, oldest first. A merge of the base into the
 * branch is listed (and marked as a merge) but its second-parent history is not.
 */
export async function branchCommits(ctx: GitContext, baseSha: string, limit = MAX_BRANCH_COMMITS): Promise<{ commits: BranchCommit[]; truncated: boolean }> {
  const { fs, dir, gitdir, cache } = ctx
  const stop = await baseAncestry(ctx, baseSha)
  const commits: BranchCommit[] = []
  let oid: string | undefined = await headSha(ctx)
  let truncated = false
  while (oid && !stop.has(oid)) {
    if (commits.length >= limit) {
      truncated = true
      break
    }
    const { commit } = await git.readCommit({ fs, dir, gitdir, cache, oid })
    commits.push({
      sha: oid,
      parents: commit.parent,
      message: commit.message.trimEnd(),
      author: commit.author.name,
      date: commit.author.timestamp * 1000,
    })
    oid = commit.parent[0]
  }
  return { commits: commits.reverse(), truncated }
}

/** How many first-parent commits HEAD is ahead of `fromSha`, or `rewritten` when it is not on that path. */
export async function headMoveSince(ctx: GitContext, fromSha: string, limit = 1000): Promise<HeadMove & { head: string }> {
  const { fs, dir, gitdir, cache } = ctx
  const head = await headSha(ctx)
  let oid: string | undefined = head
  for (let count = 0; oid && count <= limit; count++) {
    if (oid === fromSha) return { head, commits: count, rewritten: false }
    try {
      oid = (await git.readCommit({ fs, dir, gitdir, cache, oid })).commit.parent[0]
    } catch {
      break
    }
  }
  return { head, commits: null, rewritten: true }
}

type EntryType = Awaited<ReturnType<WalkerEntry['type']>>
const typeOf = async (entry: WalkerEntry | null): Promise<EntryType | null> => (entry ? entry.type() : null)
const byPath = (a: FileChange, b: FileChange) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** Files that differ between two commits (`from` null for an empty tree, e.g. a root commit). */
export async function treeChanges(ctx: GitContext, from: string | null, to: string): Promise<FileChange[]> {
  const { fs, dir, gitdir, cache } = ctx
  const trees = from ? [git.TREE({ ref: from }), git.TREE({ ref: to })] : [git.TREE({ ref: to })]
  const changes = (await git.walk({
    fs,
    dir,
    gitdir,
    cache,
    trees,
    map: async (path, entries) => {
      if (path === '.') return undefined
      const [before, after] = from ? entries : [null, entries[0]]
      const [beforeType, afterType] = await Promise.all([typeOf(before ?? null), typeOf(after ?? null)])
      if (beforeType === 'commit' || afterType === 'commit') return null
      const oldBlob = beforeType === 'blob' ? before! : null
      const newBlob = afterType === 'blob' ? after! : null
      if (!oldBlob && !newBlob) return undefined
      const [oldOid, newOid] = await Promise.all([oldBlob?.oid() ?? null, newBlob?.oid() ?? null])
      if (oldOid === newOid) return undefined
      return {
        path,
        status: !oldOid ? 'added' : !newOid ? 'deleted' : 'modified',
        oldOid: oldOid ?? null,
        newOid: newOid ?? null,
      } satisfies FileChange
    },
  })) as FileChange[]
  return changes.sort(byPath)
}

/** Both sides from the object store (or supplied blobs), for diffs between commits or against a reviewed blob. */
export async function readBlobContents(ctx: GitContext, change: FileChange, maxBytes = DEFAULT_MAX_BYTES): Promise<FileContents> {
  const [oldBytes, newBytes] = await Promise.all([
    change.oldOid ? readOldBytes(ctx, change.oldOid) : null,
    change.newOid ? readOldBytes(ctx, change.newOid) : null,
  ])
  return { path: change.path, old: oldBytes ? toSide(oldBytes, maxBytes) : null, new: newBytes ? toSide(newBytes, maxBytes) : null }
}

/** A blob from the object store, or null when it is not there. */
export async function readBlobOrNull(ctx: GitContext, oid: string): Promise<Uint8Array | null> {
  try {
    return await readOldBytes(ctx, oid)
  } catch {
    return null
  }
}

export interface ReviewSnapshot {
  head: string
  /** The working-tree content, when it matched the reviewed oid and is not already a git object. */
  bytes: Uint8Array | null
}

/**
 * What to keep of a file just marked viewed: nothing when its blob is already a git object (committed or staged),
 * otherwise its working-tree content, if it still hashes to the oid that was reviewed and fits the size cap.
 */
export async function reviewSnapshot(ctx: GitContext, path: string, oid: string, maxBytes: number): Promise<ReviewSnapshot> {
  const head = await headSha(ctx)
  if (!oid || (await readBlobOrNull(ctx, oid))) return { head, bytes: null }
  let bytes: Uint8Array
  try {
    if ((await ctx.fs.promises.stat(`/${path}`)).size > maxBytes) return { head, bytes: null }
    bytes = (await ctx.fs.promises.readFile(`/${path}`)) as Uint8Array
  } catch {
    return { head, bytes: null }
  }
  if (bytes.byteLength > maxBytes || (await hashBlob(bytes)) !== oid) return { head, bytes: null }
  return { head, bytes }
}
