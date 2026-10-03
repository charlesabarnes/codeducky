import { changedRuns, detectMovedBlocks, MAX_MOVE_LINES, type MovedIndex, type MoveInput } from '../diff/moved'
import { DEFAULT_MAX_BYTES, toSide } from '../git/sides'
import type { FileChange, FileContents, FileSide, FileStats } from '../git/types'
import { patchDiffLines } from '../review/patch'
import type { GitHubClient } from './client'
import type { PullDetail, PullFile, RepoRef } from './types'

/** A pull request as the session needs it: details, the merge base its diff is against, and its files. */
export interface PrSnapshot {
  ref: RepoRef
  pull: PullDetail
  mergeBaseSha: string
  files: PullFile[]
}

export async function loadPrSnapshot(gh: GitHubClient, ref: RepoRef, number: number): Promise<PrSnapshot> {
  const pull = await gh.pull(ref, number)
  // GitHub's PR diff is three-dot: against the merge base, not the base branch tip.
  const [comparison, files] = await Promise.all([gh.compare(ref, pull.baseSha, pull.headSha), gh.pullFiles(ref, number)])
  return { ref, pull, mergeBaseSha: comparison.mergeBaseSha, files }
}

export interface BlobMeta {
  oid: string
  size: number
  binary: boolean
}

const META_BATCH = 100

/**
 * Blob id, size and binary flag for each `commit:path` expression, via aliased GraphQL lookups
 * (100 per request). Missing paths map to null. Nothing is downloaded.
 */
export async function blobMetas(gh: GitHubClient, ref: RepoRef, expressions: readonly string[]): Promise<Map<string, BlobMeta | null>> {
  const result = new Map<string, BlobMeta | null>()
  const unique = [...new Set(expressions)]
  for (let start = 0; start < unique.length; start += META_BATCH) {
    const batch = unique.slice(start, start + META_BATCH)
    const params = batch.map((_, i) => `$e${i}: String!`).join(', ')
    const fields = batch.map((_, i) => `b${i}: object(expression: $e${i}) { ... on Blob { oid byteSize isBinary } }`).join('\n')
    const query = `query Blobs($owner: String!, $name: String!, ${params}) { repository(owner: $owner, name: $name) { ${fields} } }`
    const variables: Record<string, string> = { owner: ref.owner, name: ref.name }
    batch.forEach((expression, i) => (variables[`e${i}`] = expression))
    type Raw = { repository: Record<string, { oid?: string; byteSize?: number; isBinary?: boolean | null } | null> | null }
    const data = await gh.graphql<Raw>(query, variables)
    batch.forEach((expression, i) => {
      const blob = data.repository?.[`b${i}`]
      result.set(expression, blob?.oid ? { oid: blob.oid, size: blob.byteSize ?? 0, binary: Boolean(blob.isBinary) } : null)
    })
  }
  return result
}

export interface PrChanges {
  changes: FileChange[]
  stats: Record<string, FileStats>
  /** Size and binary flag per blob id, so contents can skip downloading binary or huge blobs. */
  metas: Map<string, BlobMeta>
  moved: MovedIndex
}

const oldPathOf = (file: PullFile) => (file.status === 'renamed' && file.previousPath ? file.previousPath : file.path)
const hasOld = (file: PullFile) => file.status !== 'added' && file.status !== 'copied'
const hasNew = (file: PullFile) => file.status !== 'removed'

/**
 * The session's changes for a pull request, built from the PR's file list and blob lookups at the
 * merge base and head. Patches are not trusted for content: GitHub leaves them out for binary,
 * large and truncated diffs. They only feed moved-block detection, where they are present.
 */
export async function buildPrChanges(gh: GitHubClient, snapshot: PrSnapshot): Promise<PrChanges> {
  const { ref, pull, mergeBaseSha, files } = snapshot
  const oldExpr = (file: PullFile) => `${mergeBaseSha}:${oldPathOf(file)}`
  const newExpr = (file: PullFile) => `${pull.headSha}:${file.path}`
  const found = await blobMetas(gh, ref, [...files.filter(hasOld).map(oldExpr), ...files.filter(hasNew).map(newExpr)])

  const metas = new Map<string, BlobMeta>()
  const changes: FileChange[] = []
  const stats: Record<string, FileStats> = {}
  for (const file of files) {
    const before = hasOld(file) ? (found.get(oldExpr(file)) ?? null) : null
    const after = hasNew(file) ? (found.get(newExpr(file)) ?? (file.sha ? { oid: file.sha, size: -1, binary: false } : null)) : null
    for (const meta of [before, after]) if (meta) metas.set(meta.oid, meta)
    if (!before && !after) continue
    const change: FileChange = {
      path: file.path,
      status: !before ? 'added' : !after ? 'deleted' : 'modified',
      oldOid: before?.oid ?? null,
      newOid: after?.oid ?? null,
    }
    if (file.status === 'renamed' && file.previousPath && before && after) change.oldPath = file.previousPath
    changes.push(change)
    if (before?.binary || after?.binary) stats[file.path] = { binary: true }
    else if (Math.max(before?.size ?? 0, after?.size ?? 0) > DEFAULT_MAX_BYTES) stats[file.path] = { tooLarge: true }
    else stats[file.path] = { additions: file.additions ?? 0, deletions: file.deletions ?? 0 }
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { changes, stats, metas, moved: movedFromPatches(files) }
}

/** Moved blocks from the patches GitHub sent; files without a patch are left out. */
export function movedFromPatches(files: readonly PullFile[]): MovedIndex {
  const inputs: MoveInput[] = []
  let total = 0
  for (const file of files) {
    if (!file.patch) continue
    const lines = patchDiffLines(file.patch)
    total += lines.filter((line) => line.kind !== 'context').length
    if (total > MAX_MOVE_LINES) return {}
    inputs.push({ path: file.path, lines: changedRuns(lines) })
  }
  return detectMovedBlocks(inputs)
}

export type BlobLoader = (oid: string) => Promise<Uint8Array>

/** One side of a file: binary and oversized blobs are reported from their metadata without downloading them. */
async function readSide(oid: string | null, metas: ReadonlyMap<string, BlobMeta>, load: BlobLoader, maxBytes: number): Promise<FileSide | null> {
  if (!oid) return null
  const meta = metas.get(oid)
  if (meta?.binary) return { kind: 'binary', size: meta.size }
  if (meta && meta.size > maxBytes) return { kind: 'too-large', size: meta.size }
  return toSide(await load(oid), maxBytes)
}

export async function prFileContents(
  change: FileChange,
  metas: ReadonlyMap<string, BlobMeta>,
  load: BlobLoader,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<FileContents> {
  const [old, next] = await Promise.all([readSide(change.oldOid, metas, load, maxBytes), readSide(change.newOid, metas, load, maxBytes)])
  return { path: change.path, old, new: next }
}
