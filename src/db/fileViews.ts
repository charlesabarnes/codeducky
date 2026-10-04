import type { FileChange } from '../git/types'
import { currentOid, lastLooks, latestReview, type LastLook } from '../review/lastLook'
import { contentHash } from '../review/viewed'
import type { SkelbertDb } from './db'
import type { FileView, LastReview, Session } from './schema'

export async function setViewed(db: SkelbertDb, view: FileView): Promise<void> {
  await db.fileViews.put(view)
}

export function sessionViews(db: SkelbertDb, sessionId: string): Promise<FileView[]> {
  return db.fileViews.where({ sessionId }).toArray()
}

type ViewedChange = Pick<FileChange, 'path' | 'oldOid' | 'newOid'>

export interface ViewedInput {
  sessionId: string
  change: ViewedChange
  viewed: boolean
  /** The head commit, when known now (pull requests); local sessions record it with `recordReviewHead`. */
  head?: string
}

/**
 * Marks a file viewed or not. Marking it viewed records the reviewed blob oid (synced, small); unmarking keeps the
 * last reviewed oid, since that look still happened. Only writes small records, so it stays instant on big files.
 */
export async function markViewed(db: SkelbertDb, { sessionId, change, viewed, head }: ViewedInput, now = Date.now()): Promise<void> {
  await db.transaction('rw', db.fileViews, db.sessions, async () => {
    const previous = await db.fileViews.get([sessionId, change.path])
    const view: FileView = { sessionId, path: change.path, contentHash: contentHash(change), viewed }
    if (viewed) Object.assign(view, { reviewedOid: currentOid(change), reviewedAt: now }, head ? { reviewedHead: head } : {})
    else if (previous?.reviewedOid) {
      Object.assign(view, { reviewedOid: previous.reviewedOid, reviewedAt: previous.reviewedAt }, previous.reviewedHead ? { reviewedHead: previous.reviewedHead } : {})
    }
    await db.fileViews.put(view)
    if (viewed && head) await db.sessions.update(sessionId, { lastReview: { headSha: head, at: now } })
  })
}

/** Records the head a local review happened at, once the git worker has read it. */
export async function recordReviewHead(db: SkelbertDb, sessionId: string, path: string, head: string, now = Date.now()): Promise<void> {
  await db.transaction('rw', db.fileViews, db.sessions, async () => {
    const view = await db.fileViews.get([sessionId, path])
    if (view?.reviewedOid && view.reviewedHead !== head) await db.fileViews.update([sessionId, path], { reviewedHead: head })
    await db.sessions.update(sessionId, { lastReview: { headSha: head, at: now } })
  })
}

/**
 * A submitted review covers every file at that head: record each as reviewed (keeping its viewed flag) and the
 * head as the session's last review.
 */
export async function recordReviewedFiles(
  db: SkelbertDb,
  sessionId: string,
  head: string,
  files: readonly ViewedChange[],
  now = Date.now(),
): Promise<void> {
  await db.transaction('rw', db.fileViews, db.sessions, async () => {
    const existing = new Map((await sessionViews(db, sessionId)).map((view) => [view.path, view]))
    const views = files.map((change): FileView => {
      const previous = existing.get(change.path)
      const hash = contentHash(change)
      return {
        sessionId,
        path: change.path,
        contentHash: hash,
        viewed: Boolean(previous?.viewed && previous.contentHash === hash),
        reviewedOid: currentOid(change),
        reviewedHead: head,
        reviewedAt: now,
      }
    })
    if (views.length) await db.fileViews.bulkPut(views)
    await db.sessions.update(sessionId, { lastReview: { headSha: head, at: now } })
  })
}

/** At archive: a session with viewed files and no recorded review gets its head as the last review. */
export async function recordArchivedReview(db: SkelbertDb, session: Session, now = Date.now()): Promise<void> {
  if (session.id === undefined || session.lastReview) return
  const viewed = await db.fileViews.where({ sessionId: session.id }).filter((view) => view.viewed).count()
  if (viewed > 0) await db.sessions.update(session.id, { lastReview: { headSha: session.headSha, at: now } })
}

export interface LastLookData {
  looks: Map<string, LastLook>
  review: LastReview | null
}

/** Your last look at each file across the given sessions (one branch, or one pull request). */
export async function loadLastLooks(db: SkelbertDb, sessions: readonly Session[]): Promise<LastLookData> {
  const ids = sessions.flatMap((session) => (session.id === undefined ? [] : [session.id]))
  const views = ids.length ? await db.fileViews.where('sessionId').anyOf(ids).toArray() : []
  return { looks: lastLooks(views), review: latestReview(sessions) }
}
