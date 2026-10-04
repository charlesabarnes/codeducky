import type { FileView, LastReview, Session } from '../db/schema'
import type { FileChange } from '../git/types'

/** The reviewed oid of a file that did not exist (deleted) when it was reviewed; matches `contentHash`'s placeholder. */
export const ABSENT = '0'

/** What you last reviewed of one file: its content's blob oid, the head then, and when. */
export interface LastLook {
  path: string
  oid: string
  head: string | null
  at: number
}

/** The oid a view records, including views saved before reviewed oids existed (their content hash ends in it). */
function reviewedOidOf(view: FileView): string | null {
  if (view.reviewedOid) return view.reviewedOid
  if (!view.viewed) return null
  const separator = view.contentHash.lastIndexOf(':')
  return separator < 0 ? null : view.contentHash.slice(separator + 1) || null
}

/** The latest look per path across the given views (normally every session of one branch or pull request). */
export function lastLooks(views: readonly FileView[]): Map<string, LastLook> {
  const looks = new Map<string, LastLook>()
  for (const view of views) {
    const oid = reviewedOidOf(view)
    if (!oid) continue
    const at = view.reviewedAt ?? view.changedAt ?? 0
    const current = looks.get(view.path)
    if (current && current.at >= at) continue
    looks.set(view.path, { path: view.path, oid, head: view.reviewedHead ?? null, at })
  }
  return looks
}

/** The most recent review recorded on any of the sessions. */
export function latestReview(sessions: readonly Pick<Session, 'lastReview'>[]): LastReview | null {
  let latest: LastReview | null = null
  for (const session of sessions) {
    if (session.lastReview && (!latest || session.lastReview.at > latest.at)) latest = session.lastReview
  }
  return latest
}

/**
 * - `new`: never viewed; the full diff, badged "new since last look".
 * - `changed`: the interdiff from the reviewed content to the current content.
 * - `unchanged`: identical to what you reviewed; hidden behind a count.
 * - `missing`: changed, but the reviewed content is not available here; the full diff with a notice.
 */
export type SinceKind = 'new' | 'changed' | 'unchanged' | 'missing'

export interface SinceEntry {
  kind: SinceKind
  /** What the diff shows: the interdiff for `changed`, otherwise the file's own change. */
  change: FileChange
  /** The file's change against the base. */
  original: FileChange
  look: LastLook | null
}

/** The current-side oid of a change, with ABSENT for a deleted file. */
export const currentOid = (change: Pick<FileChange, 'newOid'>) => change.newOid ?? ABSENT

export function interdiff(change: FileChange, reviewedOid: string): FileChange {
  const oldOid = reviewedOid === ABSENT ? null : reviewedOid
  const status = change.newOid === null ? 'deleted' : oldOid === null ? 'added' : 'modified'
  return { path: change.path, status, oldOid, newOid: change.newOid }
}

/**
 * Sorts the session's files by what changed since you last looked at each one. `available` says whether the
 * reviewed content can be read (a git object, a local snapshot, or a GitHub blob).
 */
export function classifySince(
  files: readonly FileChange[],
  looks: ReadonlyMap<string, LastLook>,
  available: (oid: string) => boolean,
): SinceEntry[] {
  return files.map((file) => {
    const look = looks.get(file.path) ?? null
    if (!look) return { kind: 'new', change: file, original: file, look }
    if (look.oid === currentOid(file)) return { kind: 'unchanged', change: file, original: file, look }
    if (look.oid !== ABSENT && !available(look.oid)) return { kind: 'missing', change: file, original: file, look }
    return { kind: 'changed', change: interdiff(file, look.oid), original: file, look }
  })
}

export interface SinceCounts {
  changed: number
  unchanged: number
  fresh: number
  missing: number
}

export function countSince(entries: readonly SinceEntry[]): SinceCounts {
  const counts: SinceCounts = { changed: 0, unchanged: 0, fresh: 0, missing: 0 }
  for (const entry of entries) {
    if (entry.kind === 'changed') counts.changed++
    else if (entry.kind === 'unchanged') counts.unchanged++
    else if (entry.kind === 'new') counts.fresh++
    else counts.missing++
  }
  return counts
}
