import { isBinary } from './contents'
import { fingerprint, similarity, type Fingerprint } from './similarity'
import type { FileChange, RenameResult } from './types'

/** git's default: 50% similar or more is a rename. */
export const MIN_SIMILARITY = 0.5
/** Content comparison is skipped when deleted × added exceeds this (git's diff.renameLimit is 1000 per side). */
export const MAX_RENAME_PAIRS = 250_000
/** Files bigger than this are only paired by identical content. */
export const MAX_RENAME_BYTES = 1024 * 1024

export interface RenameReader {
  /** Base-side content of a deleted file. */
  readOld(change: FileChange): Promise<Uint8Array>
  /** Working-tree content of an added file. */
  readNew(change: FileChange): Promise<Uint8Array>
}

export interface RenameOptions {
  minSimilarity?: number
  maxPairs?: number
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const byPath = (a: FileChange, b: FileChange) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

const renamed = (deleted: FileChange, added: FileChange, score: number): FileChange => ({
  path: added.path,
  status: 'modified',
  oldOid: deleted.oldOid,
  newOid: added.newOid,
  oldPath: deleted.path,
  similarity: Math.floor(score * 100),
})

/** Exact renames: identical blobs. Same-named files win when several deletions share content. */
type Pairs = Map<FileChange, { source: FileChange; score: number }>

function pairExact(deleted: FileChange[], added: FileChange[], pairs: Pairs) {
  const byOid = new Map<string, FileChange[]>()
  for (const change of deleted) {
    if (!change.oldOid) continue
    byOid.set(change.oldOid, [...(byOid.get(change.oldOid) ?? []), change])
  }
  for (const change of added) {
    const sources = change.newOid ? byOid.get(change.newOid) : undefined
    if (!sources?.length) continue
    const index = Math.max(0, sources.findIndex((source) => basename(source.path) === basename(change.path)))
    pairs.set(change, { source: sources[index]!, score: 1 })
    sources.splice(index, 1)
  }
}

async function readFingerprints(
  changes: FileChange[],
  read: (change: FileChange) => Promise<Uint8Array>,
): Promise<Map<FileChange, Fingerprint>> {
  const prints = new Map<FileChange, Fingerprint>()
  for (const change of changes) {
    const bytes = await read(change).catch(() => null)
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_RENAME_BYTES || isBinary(bytes)) continue
    prints.set(change, fingerprint(bytes))
  }
  return prints
}

interface Candidate {
  deleted: FileChange
  added: FileChange
  score: number
  sameName: boolean
}

/**
 * Pairs deleted and added files into renames, like `git diff -M`: identical content first, then
 * the most similar pairs at or above the threshold, each file used once.
 */
export async function detectRenames(changes: readonly FileChange[], reader: RenameReader, options: RenameOptions = {}): Promise<RenameResult> {
  const minimum = options.minSimilarity ?? MIN_SIMILARITY
  const maxPairs = options.maxPairs ?? MAX_RENAME_PAIRS
  const deleted = changes.filter((change) => change.status === 'deleted')
  const added = changes.filter((change) => change.status === 'added')
  if (deleted.length === 0 || added.length === 0) return { changes: [...changes], limited: false }

  const pairs: Pairs = new Map()
  pairExact(deleted, added, pairs)
  const used = new Set([...pairs.values()].map((pair) => pair.source))
  const openDeleted = deleted.filter((change) => !used.has(change))
  const openAdded = added.filter((change) => !pairs.has(change))
  const limited = openDeleted.length * openAdded.length > maxPairs

  if (!limited && openDeleted.length > 0 && openAdded.length > 0) {
    const oldPrints = await readFingerprints(openDeleted, reader.readOld)
    const newPrints = await readFingerprints(openAdded, reader.readNew)
    const candidates: Candidate[] = []
    for (const [source, oldPrint] of oldPrints) {
      for (const [target, newPrint] of newPrints) {
        const score = similarity(oldPrint, newPrint, minimum)
        if (score >= minimum) {
          candidates.push({ deleted: source, added: target, score, sameName: basename(source.path) === basename(target.path) })
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score || Number(b.sameName) - Number(a.sameName) || byPath(a.added, b.added))
    for (const { deleted: source, added: target, score } of candidates) {
      if (used.has(source) || pairs.has(target)) continue
      pairs.set(target, { source, score })
      used.add(source)
    }
  }

  const result: FileChange[] = []
  for (const change of changes) {
    if (change.status === 'deleted' && used.has(change)) continue
    const pair = pairs.get(change)
    result.push(pair ? renamed(pair.source, change, pair.score) : change)
  }
  return { changes: result.sort(byPath), limited }
}

