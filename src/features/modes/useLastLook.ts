import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { db } from '../../db/db'
import { loadLastLooks, type LastLookData } from '../../db/fileViews'
import { prSessions } from '../../db/prSessions'
import { snapshotOids } from '../../db/reviewSnapshots'
import { isPrSession, type LastReview, type Session } from '../../db/schema'
import { gitService } from '../../git/client'
import type { FileChange, HeadMove } from '../../git/types'
import type { GitHubClient } from '../../github/client'
import type { RepoRef } from '../../github/types'
import { ABSENT, classifySince, countSince, type SinceCounts, type SinceEntry } from '../../review/lastLook'

/** Every session of the same branch (local) or pull request: your last look can be in an earlier one. */
async function relatedSessions(session: Session): Promise<Session[]> {
  if (isPrSession(session) && session.pr) return prSessions(db, session.repoId, session.pr.number)
  return db.sessions.where({ repoId: session.repoId, branch: session.branch }).filter((s) => !isPrSession(s)).toArray()
}

/** Local sessions read through the git worker, which the session's scan has already opened on the repo. */
export type LastLookOrigin = { kind: 'local' } | { kind: 'pr'; gh: GitHubClient; ref: RepoRef; head: string }

export interface HeadChange extends HeadMove {
  /** The head you last reviewed at. */
  from: string
  /** The head now. */
  to: string
}

export interface LastLookState {
  entries: SinceEntry[] | null
  counts: SinceCounts | null
  /** The last review recorded before this visit, held so the banner stays put while you mark files viewed. */
  resumed: LastReview | null
  /** Set when the head moved since that review. */
  headChange: HeadChange | null
}

/** Which reviewed oids can be read here: pull request blobs always (GitHub has them); local ones from git or a snapshot. */
function useAvailable(origin: LastLookOrigin, data: LastLookData | undefined, ready: boolean): ReadonlySet<string> | 'all' | null {
  const [found, setFound] = useState<{ key: string; oids: Set<string> } | null>(null)
  const oids = useMemo(() => [...new Set([...(data?.looks.values() ?? [])].map((look) => look.oid))].filter((oid) => oid !== ABSENT).sort(), [data])
  const key = oids.join()
  const local = origin.kind === 'local'
  useEffect(() => {
    if (!local || !data || !ready) return
    let cancelled = false
    const run = async () => {
      const git = gitService()
      const [inGit, snapshots] = await Promise.all([git.hasBlobs(oids), snapshotOids(db, oids)])
      if (!cancelled) setFound({ key, oids: new Set([...inGit, ...snapshots]) })
    }
    run().catch((error: unknown) => {
      console.warn('Could not check reviewed versions', error)
      if (!cancelled) setFound({ key, oids: new Set() })
    })
    return () => {
      cancelled = true
    }
  }, [local, data, ready, key, oids])
  if (origin.kind === 'pr') return 'all'
  return found?.key === key ? found.oids : null
}

/** How the head moved since `from`: the local first-parent walk, or GitHub's compare API for pull requests. */
async function headMove(origin: LastLookOrigin, from: string): Promise<HeadChange> {
  if (origin.kind === 'pr') {
    if (from === origin.head) return { from, to: origin.head, commits: 0, rewritten: false }
    const comparison = await origin.gh.compare(origin.ref, from, origin.head)
    const rewritten = comparison.status === 'diverged' || comparison.status === 'behind'
    return { from, to: origin.head, commits: rewritten ? null : comparison.aheadBy, rewritten }
  }
  const move = await gitService().headMoveSince(from)
  return { from, to: move.head, commits: move.commits, rewritten: move.rewritten }
}

/** Your last look at each file of the session, the files sorted by what changed since, and how far the head moved. */
export function useLastLook(session: Session, files: readonly FileChange[] | null, origin: LastLookOrigin): LastLookState {
  const data = useLiveQuery(() => relatedSessions(session).then((sessions) => loadLastLooks(db, sessions)), [session.id, session.repoId, session.branch, session.pr?.number])
  const ready = files !== null
  const available = useAvailable(origin, data, ready)

  const [resumed, setResumed] = useState<{ review: LastReview | null } | null>(null)
  if (resumed === null && data) setResumed({ review: data.review })

  const [headChange, setHeadChange] = useState<HeadChange | null>(null)
  const from = resumed?.review?.headSha ?? null
  const originKey = origin.kind === 'pr' ? `pr:${origin.head}` : 'local'
  useEffect(() => {
    if (!from || !ready) return
    let cancelled = false
    headMove(origin, from)
      .then((move) => !cancelled && setHeadChange(move.from === move.to ? null : move))
      .catch((error: unknown) => {
        console.warn('Could not compare heads', error)
        if (!cancelled && origin.kind === 'pr' && from !== origin.head) setHeadChange({ from, to: origin.head, commits: null, rewritten: true })
      })
    return () => {
      cancelled = true
    }
    // origin is rebuilt every render; originKey tracks what matters in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, originKey, ready])

  const entries = useMemo(() => {
    if (!data || !files || available === null) return null
    return classifySince(files, data.looks, (oid) => available === 'all' || available.has(oid))
  }, [data, files, available])
  const counts = useMemo(() => (entries ? countSince(entries) : null), [entries])
  return { entries, counts, resumed: resumed?.review ?? null, headChange }
}
