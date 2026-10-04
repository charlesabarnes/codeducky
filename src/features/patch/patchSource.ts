import type { FileChange, FileSide, FileStats } from '../../git/types'
import { hashBlob } from '../../git/hash'
import { movedFromPatches } from '../../github/prDiff'
import type { PullFile } from '../../github/types'
import { patchSides, type PatchFile } from '../../review/patchSet'
import type { DiffSource } from '../session/source'

type Sides = { old: FileSide | null; new: FileSide | null }

interface Built {
  changes: FileChange[]
  sides: Map<string, Sides>
}

const BINARY: FileSide = { kind: 'binary', size: 0 }
const encode = (text: string) => new TextEncoder().encode(text)
const textSide = (text: string | null): FileSide | null => (text === null ? null : { kind: 'text', text, size: encode(text).byteLength })
const oidOf = async (text: string | null) => (text === null ? null : hashBlob(encode(text)))

async function build(files: readonly PatchFile[]): Promise<Built> {
  const changes: FileChange[] = []
  const sides = new Map<string, Sides>()
  for (const file of files) {
    const text = patchSides(file)
    // Ids of the content the patch shows, so notes and viewed state treat each side like a blob.
    const [oldOid, newOid] = await Promise.all([oidOf(text.old), oidOf(text.new)])
    const change: FileChange = { path: file.path, status: file.status, oldOid, newOid }
    if (file.oldPath) change.oldPath = file.oldPath
    changes.push(change)
    sides.set(
      file.path,
      file.binary
        ? { old: text.old === null ? null : BINARY, new: text.new === null ? null : BINARY }
        : { old: textSide(text.old), new: textSide(text.new) },
    )
  }
  return { changes, sides }
}

const asPullFile = (file: PatchFile): PullFile => ({
  path: file.path,
  previousPath: file.oldPath ?? null,
  status: file.status === 'deleted' ? 'removed' : file.oldPath ? 'renamed' : file.status,
  patch: file.binary ? null : file.hunks,
})

/** A patch file's changes: read-only, with each side rebuilt from the hunks. */
export function patchSource(key: string, files: readonly PatchFile[], head: string): DiffSource {
  let built: Promise<Built> | null = null
  const ready = () => (built ??= build(files))
  return {
    key: `patch:${key}`,
    listFiles: async () => ({ files: (await ready()).changes, renamesLimited: false }),
    async analyze() {
      const stats: Record<string, FileStats> = {}
      for (const file of files) stats[file.path] = file.binary ? { binary: true } : { additions: file.additions, deletions: file.deletions }
      return { stats, moved: movedFromPatches(files.map(asPullFile)) }
    },
    async contents(change) {
      const sides = (await ready()).sides.get(change.path)
      if (!sides) throw new Error(`${change.path} is not in this patch.`)
      return { path: change.path, ...sides }
    },
    ciHead: async () => head,
    dirtyPaths: async () => new Set(),
  }
}
