import { useLiveQuery } from 'dexie-react-hooks'
import { lazy, Suspense, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { Crumbs, StatusBar } from '../../app/chrome'
import { db } from '../../db/db'
import { patchRepo } from '../../db/patchSessions'
import { repoLabel } from '../../db/repos'
import { isPatchSession, isPrSession, type Note, type Repo, type Session } from '../../db/schema'
import { repoRef } from '../../github/connect'
import { useShortcuts, useKeys } from '../../keys/context'
import { viewedPaths } from '../../review/viewed'
import { useCiStatus } from '../ci/useCiStatus'
import type { EditSource } from '../editor/editSource'
import { useLeaveGuard } from '../editor/useLeaveGuard'
import { recordViewed } from '../modes/recordViewed'
import { MissingPatch } from '../patch/PatchSession'
import { usePatchSource } from '../patch/usePatchSource'
import { prSource } from '../pr/prSource'
import { SnapshotStatus } from '../pr/PrSession'
import { usePrSnapshot } from '../pr/usePrSnapshot'
import { RepoFolderGate } from '../repos/RepoFolderGate'
import { FilePane, type NoteFocus } from '../session/FilePane'
import { currentPath, renamedPaths } from '../session/renames'
import { localSource, type DiffSource } from '../session/source'
import { useSessionScan } from '../session/useSessionScan'
import { useViewPrefs } from '../session/useViewPrefs'
import { useDirtyElsewhere, useNoteFocusFrom, usePublishDirty } from './windowSync'

const EditorPane = lazy(async () => ({ default: (await import('../editor/EditorPane')).EditorPane }))

const EMPTY_NOTES: Note[] = []

/** /sessions/:id/window?file=…: one file of a session, its diff and notes, without the sidebar. */
export function FileWindowPage() {
  const sessionId = useParams().sessionId ?? ''
  const path = useSearchParams()[0].get('file')
  const data = useLiveQuery(async () => {
    const session = await db.sessions.get(sessionId)
    const repo = session && !isPatchSession(session) ? await db.repos.get(session.repoId) : undefined
    return { session, repo }
  }, [sessionId])

  if (!data) return <p className="page muted">Loading…</p>
  const { session, repo } = data
  if (!session || !path) return <p className="page error">{session ? 'No file was given.' : 'Session not found.'}</p>
  if (isPatchSession(session)) return <PatchFileWindow session={session} path={path} />
  if (!repo) return <p className="page error">Session not found.</p>
  if (session.status === 'archived') return <p className="page muted">This session is archived. Open it from the main window to see its report.</p>
  const opened = { ...repo, id: session.repoId }
  if (isPrSession(session) && session.pr) return <PrFileWindow session={session} repo={opened} path={path} />
  return (
    <RepoFolderGate repo={opened}>
      {(local) => <LocalFileWindow session={session} repo={local} dirHandle={local.dirHandle} path={path} />}
    </RepoFolderGate>
  )
}

interface WindowProps {
  session: Session
  repo: Repo
  path: string
}

function PatchFileWindow({ session, path }: Omit<WindowProps, 'repo'>) {
  const source = usePatchSource(session)
  if (source === undefined) return <p className="page muted">Loading…</p>
  if (source === null) return <MissingPatch />
  return <FileWindow session={session} repo={patchRepo(session)} source={source} path={path} edit={null} />
}

function PrFileWindow({ session, repo, path }: WindowProps) {
  const pr = session.pr!
  const ref = useMemo(() => ({ owner: pr.owner, name: pr.name }), [pr.owner, pr.name])
  const state = usePrSnapshot(ref, pr.number, 0)
  const ready = state.status === 'ready' ? state : null
  const source = useMemo(() => ready && prSource(ready.gh, ready.snapshot), [ready])
  if (!source) return <SnapshotStatus state={state} pull={{ ...ref, number: pr.number }} />
  return <FileWindow session={session} repo={repo} source={source} path={path} edit={null} head={ready!.snapshot.pull.headSha} />
}

function LocalFileWindow({ session, repo, dirHandle, path }: WindowProps & { dirHandle: FileSystemDirectoryHandle }) {
  const github = session.baseSource === 'github' ? repoRef(repo) : null
  const owner = github?.owner ?? null
  const name = github?.name ?? null
  const source = useMemo(
    () => localSource(dirHandle, session.baseSha, owner && name ? { owner, name } : null),
    [dirHandle, session.baseSha, owner, name],
  )
  const edit = useMemo<EditSource>(() => ({ kind: 'local', root: dirHandle }), [dirHandle])
  return <FileWindow session={session} repo={repo} source={source} path={path} edit={edit} />
}

interface FileWindowProps extends WindowProps {
  source: DiffSource
  /** Where the editor saves; only local sessions edit here. */
  edit: EditSource | null
  /** The pull request head, for viewed state. */
  head?: string
}

function FileWindow({ session, repo, source, path, edit, head }: FileWindowProps) {
  const sessionId = session.id!
  const scan = useSessionScan(source)
  const [params, setParams] = useSearchParams()
  const prefs = useViewPrefs()
  const { announce } = useKeys()
  const [focus, setFocus] = useState<NoteFocus | null>(null)
  const [dirty, setDirty] = useState(false)
  const notes = useLiveQuery(() => db.notes.where({ sessionId }).toArray(), [sessionId]) ?? EMPTY_NOTES
  const views = useLiveQuery(() => db.fileViews.where({ sessionId }).toArray(), [sessionId])
  const ci = useCiStatus(repo, source, scan.files, 0)

  const renamed = useMemo(() => renamedPaths(scan.files), [scan.files])
  const change = useMemo(() => scan.files?.find((file) => file.path === path) ?? null, [scan.files, path])
  const fileNotes = useMemo(() => notes.filter((note) => currentPath(note.path, renamed) === path), [notes, renamed, path])
  const viewed = useMemo(() => viewedPaths(scan.files ?? [], views ?? []), [scan.files, views]).has(path)
  const blocked = !edit ? (isPatchSession(session) ? 'A patch is read-only' : 'Edit pull request files from the main window') : change?.status === 'deleted' ? 'This file was deleted on the branch' : null
  const editing = params.get('view') === 'edit' && change !== null && blocked === null
  const dirtyPath = dirty ? path : null
  const elsewhere = useDirtyElsewhere(sessionId).has(path)
  useLeaveGuard(dirtyPath)
  usePublishDirty(sessionId, dirtyPath)
  useNoteFocusFrom(sessionId, path, (noteId) => setFocus({ id: noteId, at: Date.now() }))

  const setEditing = (next: boolean) => {
    if (next && blocked) return announce(blocked, { visible: true })
    setParams(next ? { file: path, view: 'edit' } : { file: path }, { replace: true })
  }
  const toggleViewed = () => {
    if (!change) return
    const reviewHead = head ?? (isPatchSession(session) ? session.headSha : null)
    recordViewed(sessionId, change, !viewed, reviewHead).catch((error: unknown) => console.error('Could not record the review', error))
  }
  useShortcuts('session', {
    'file.viewed': toggleViewed,
    'view.mode': () => prefs.setMode(prefs.mode === 'split' ? 'unified' : 'split'),
    'view.whitespace': () => prefs.setIgnoreWhitespace(!prefs.ignoreWhitespace),
    'file.edit': () => setEditing(!editing),
  })

  const label = isPatchSession(session) ? session.branch : repoLabel(repo)
  const openNotes = fileNotes.filter((note) => note.status === 'open').length
  return (
    <div className="file-window">
      <Crumbs>
        <span>{label}</span>
        <span>/</span>
        <strong>{path}</strong>
      </Crumbs>
      <StatusBar mode={editing ? 'edit' : 'file'}>
        {dirty && <span>unsaved</span>}
        <span>
          {openNotes} open {openNotes === 1 ? 'note' : 'notes'}
        </span>
      </StatusBar>
      <section className={editing ? 'session-content editing' : 'session-content'}>
        {scan.error && <p className="diff-notice error">{scan.error}</p>}
        {!scan.files && !scan.error && <p className="diff-notice muted">Loading…</p>}
        {scan.files && !change && <p className="diff-notice muted">{path} is not in this session’s changes any more.</p>}
        {change && edit && (editing || dirty) && (
          <Suspense fallback={editing && <p className="diff-notice muted">Loading the editor…</p>}>
            <EditorPane
              change={change}
              source={edit}
              hidden={!editing}
              dirty={dirty}
              dirtyElsewhere={elsewhere}
              onDirtyChange={setDirty}
              onSaved={(message) => announce(message, { visible: true })}
              onShowDiff={() => setEditing(false)}
            />
          </Suspense>
        )}
        {change && !editing && (
          <FilePane
            key={`${source.key}:${change.path}`}
            sessionId={sessionId}
            source={source}
            threads={null}
            threadActions={null}
            change={change}
            notes={fileNotes}
            mode={prefs.mode}
            onModeChange={prefs.setMode}
            ignoreWhitespace={prefs.ignoreWhitespace}
            onIgnoreWhitespaceChange={prefs.setIgnoreWhitespace}
            moved={undefined}
            onOpenMoved={() => undefined}
            ci={ci}
            generation={0}
            viewed={viewed}
            onToggleViewed={toggleViewed}
            focus={focus}
            navRequest={null}
            onBoundary={() => false}
            collapseViewed={false}
            onNoteRefused={(message) => announce(message, { visible: true })}
            edit={{ onEdit: () => setEditing(true), blocked, dirty }}
          />
        )}
      </section>
    </div>
  )
}
