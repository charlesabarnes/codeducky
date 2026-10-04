import type { PrSnapshot } from '../github/prDiff'
import { carryOverNotes } from '../review/carryOver'
import { repoIdFor } from '../sync/ids'
import type { RubberduckDb } from './db'
import type { Session, SessionPullRequest } from './schema'

const isPrFor = (number: number) => (session: Session) => session.source === 'github-pr' && session.pr?.number === number

/** Sessions of one pull request, oldest first. */
export async function prSessions(db: RubberduckDb, repoId: string, number: number): Promise<Session[]> {
  return db.sessions.where({ repoId }).filter(isPrFor(number)).sortBy('startedAt')
}

export async function activePrSession(db: RubberduckDb, owner: string, name: string, number: number): Promise<Session | undefined> {
  const repoId = repoIdFor(owner, name)
  if (!repoId) return undefined
  return (await prSessions(db, repoId, number)).filter((session) => session.status === 'active').at(-1)
}

const prFields = ({ ref, pull }: PrSnapshot): SessionPullRequest => ({
  owner: ref.owner,
  name: ref.name,
  number: pull.number,
  title: pull.title,
  url: pull.htmlUrl,
  author: pull.author,
  baseRef: pull.baseRef,
})

/**
 * Opens the review session for a pull request: resumes the active one (moving it to the PR's
 * current head) or starts one, carrying open notes over from the last session of the same PR.
 * The repo is `gh:owner/name`, created without a local folder when this device has none.
 */
export async function openPrSession(db: RubberduckDb, snapshot: PrSnapshot, now = Date.now()): Promise<string> {
  const { ref, pull, mergeBaseSha } = snapshot
  const repoId = repoIdFor(ref.owner, ref.name)
  if (!repoId) throw new Error('A pull request needs an owner and a repository name.')
  return db.transaction('rw', db.repos, db.sessions, db.notes, async () => {
    const repo = await db.repos.get(repoId)
    if (repo) await db.repos.update(repoId, { lastOpenedAt: now, ...(repo.baseBranch ? {} : { baseBranch: pull.baseRef }) })
    else {
      await db.repos.add({ id: repoId, owner: ref.owner, name: ref.name, folderName: '', baseBranch: pull.baseRef, checklistIds: [], lastOpenedAt: now })
    }

    const sessions = await prSessions(db, repoId, pull.number)
    const fields = { branch: pull.headRef, headSha: pull.headSha, baseSha: mergeBaseSha, pr: prFields(snapshot) }
    const active = sessions.filter((session) => session.status === 'active').at(-1)
    if (active?.id !== undefined) {
      const current = active.pr
      const changed =
        active.headSha !== fields.headSha ||
        active.baseSha !== fields.baseSha ||
        active.branch !== fields.branch ||
        current?.title !== fields.pr.title ||
        current?.baseRef !== fields.pr.baseRef
      if (changed) await db.sessions.update(active.id, fields)
      return active.id
    }

    const previous = sessions.at(-1)
    const sessionId = (await db.sessions.add({
      repoId,
      ...fields,
      baseSource: 'github',
      source: 'github-pr',
      startedAt: Math.max(now, (previous?.startedAt ?? 0) + 1),
      status: 'active',
    })) as string
    if (previous?.id !== undefined) {
      // Notes already sent to GitHub live on as review threads there; only unsent ones carry over.
      const notes = await db.notes.where({ sessionId: previous.id }).filter((note) => note.github?.reviewId === undefined).toArray()
      await db.notes.bulkAdd(carryOverNotes(notes, sessionId, now))
    }
    return sessionId
  })
}
