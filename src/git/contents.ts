import git from 'isomorphic-git'
import { countChanges } from '../diff/hunks'
import type { GitContext } from './context'
import { DEFAULT_MAX_BYTES, toSide } from './sides'
import type { FileChange, FileContents, FileSide, FileStats } from './types'

export { DEFAULT_MAX_BYTES, isBinary } from './sides'

export async function readOldBytes(ctx: GitContext, oid: string): Promise<Uint8Array> {
  const { fs, dir, gitdir, cache, blobs } = ctx
  const supplied = blobs.get(oid)
  if (supplied) return supplied
  return (await git.readBlob({ fs, dir, gitdir, cache, oid })).blob
}

export async function readNewBytes({ fs }: GitContext, path: string): Promise<Uint8Array> {
  return (await fs.promises.readFile(`/${path}`)) as Uint8Array
}

export async function readFileContents(
  ctx: GitContext,
  change: FileChange,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<FileContents> {
  const [oldBytes, newBytes] = await Promise.all([
    change.oldOid ? readOldBytes(ctx, change.oldOid) : null,
    change.status === 'deleted' ? null : readNewBytes(ctx, change.path),
  ])
  return {
    path: change.path,
    old: oldBytes ? toSide(oldBytes, maxBytes) : null,
    new: newBytes ? toSide(newBytes, maxBytes) : null,
  }
}

export function statsFor(contents: FileContents): FileStats {
  const sides = [contents.old, contents.new]
  if (sides.some((side) => side?.kind === 'binary')) return { binary: true }
  if (sides.some((side) => side?.kind === 'too-large')) return { tooLarge: true }
  const text = (side: FileSide | null) => (side?.kind === 'text' ? side.text : '')
  return countChanges(text(contents.old), text(contents.new))
}

export async function readFileStats(
  ctx: GitContext,
  changes: FileChange[],
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<Record<string, FileStats>> {
  const stats: Record<string, FileStats> = {}
  for (const change of changes) {
    stats[change.path] = statsFor(await readFileContents(ctx, change, maxBytes))
  }
  return stats
}

/** The oids that neither the local object store nor the supplied blobs can provide. */
export async function missingBlobs(ctx: GitContext, oids: string[]): Promise<string[]> {
  const missing: string[] = []
  for (const oid of new Set(oids)) {
    try {
      await readOldBytes(ctx, oid)
    } catch {
      missing.push(oid)
    }
  }
  return missing
}
