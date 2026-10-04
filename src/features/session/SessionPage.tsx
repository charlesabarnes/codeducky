import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo } from 'react'
import { useParams } from 'react-router'
import { rememberSession } from '../../app/lastSession'
import { db } from '../../db/db'
import { isPrSession, type OpenedRepo, type Session } from '../../db/schema'
import { repoRef } from '../../github/connect'
import { SessionReport } from '../history/SessionReport'
import { PrSession } from '../pr/PrSession'
import { RepoFolderGate } from '../repos/RepoFolderGate'
import { localSource } from './source'
import { SessionView } from './SessionView'

export function SessionPage() {
  const sessionId = useParams().sessionId ?? ''
  const data = useLiveQuery(async () => {
    const session = await db.sessions.get(sessionId)
    const repo = session ? await db.repos.get(session.repoId) : undefined
    return { session, repo }
  }, [sessionId])
  const found = Boolean(data?.session)
  useEffect(() => {
    if (found) rememberSession(sessionId)
  }, [found, sessionId])

  if (!data) return <p className="page muted">Loading…</p>
  const { session, repo } = data
  if (!session || !repo) return <p className="page error">Session not found.</p>
  if (session.status === 'archived') return <SessionReport session={session} repo={repo} />
  if (isPrSession(session) && session.pr) return <PrSession session={session} repo={{ ...repo, id: session.repoId }} />
  return (
    <RepoFolderGate repo={{ ...repo, id: session.repoId }}>
      {(opened) => <LocalSession session={session} repo={opened} />}
    </RepoFolderGate>
  )
}

function LocalSession({ session, repo }: { session: Session; repo: OpenedRepo }) {
  const github = session.baseSource === 'github' ? repoRef(repo) : null
  const owner = github?.owner ?? null
  const name = github?.name ?? null
  const source = useMemo(
    () => localSource(repo.dirHandle, session.baseSha, owner && name ? { owner, name } : null),
    [repo.dirHandle, session.baseSha, owner, name],
  )
  return <SessionView session={session} repo={repo} source={source} dirHandle={repo.dirHandle} pr={null} />
}
