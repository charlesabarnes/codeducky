import git from 'isomorphic-git'
import { countChanges } from '../diff/hunks'
import type { GitContext } from './context'
import type { FileChange, FileContents, FileSide, FileStats } from './types'

export const DEFAULT_MAX_BYTES = 1024 * 1024
const BINARY_SNIFF_BYTES = 8000

export function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.byteLength, BINARY_SNIFF_BYTES)
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true
  return false
}

function toSide(bytes: Uint8Array, maxBytes: number): FileSide {
  const size = bytes.byteLength
  if (isBinary(bytes)) return { kind: 'binary', size }
  if (size > maxBytes) return { kind: 'too-large', size }
  return { kind: 'text', text: new TextDecoder().decode(bytes), size }
}

async function readOld(ctx: GitContext, oid: string): Promise<Uint8Array> {
  const { fs, dir, gitdir, cache } = ctx
  return (await git.readBlob({ fs, dir, gitdir, cache, oid })).blob
}

async function readNew({ fs }: GitContext, path: string): Promise<Uint8Array> {
  return (await fs.promises.readFile(`/${path}`)) as Uint8Array
}

export async function readFileContents(
  ctx: GitContext,
  change: FileChange,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<FileContents> {
  const [oldBytes, newBytes] = await Promise.all([
    change.oldOid ? readOld(ctx, change.oldOid) : null,
    change.status === 'deleted' ? null : readNew(ctx, change.path),
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
