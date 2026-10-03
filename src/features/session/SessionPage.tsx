import { useLiveQuery } from 'dexie-react-hooks'
import { useParams } from 'react-router'
import { db } from '../../db/db'
import { SessionReport } from '../history/SessionReport'
import { RepoFolderGate } from '../repos/RepoFolderGate'
import { SessionView } from './SessionView'

export function SessionPage() {
  const sessionId = useParams().sessionId ?? ''
  const data = useLiveQuery(async () => {
    const session = await db.sessions.get(sessionId)
    const repo = session ? await db.repos.get(session.repoId) : undefined
    return { session, repo }
  }, [sessionId])

  if (!data) return <p className="page muted">Loading…</p>
  const { session, repo } = data
  if (!session || !repo) return <p className="page error">Session not found.</p>
  if (session.status === 'archived') return <SessionReport session={session} repo={repo} />
  return (
    <RepoFolderGate repo={{ ...repo, id: session.repoId }}>
      {(opened) => <SessionView session={session} repo={opened} />}
    </RepoFolderGate>
  )
}
