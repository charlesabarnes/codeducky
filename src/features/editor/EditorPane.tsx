import { CircleAlert, Lock, RotateCcw, Save, Unlock } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef } from 'react'
import type { EditorController } from '../../editor/controller'
import { languageFor } from '../../diff/highlight'
import type { FileChange } from '../../git/types'
import { useShortcuts } from '../../keys/context'
import { withShortcut } from '../../keys/help'
import { isMac } from '../../keys/tokens'
import { SplitPath } from '../session/FileList'
import { CommitDialog } from './CommitDialog'
import type { EditSource } from './editSource'
import { useFileEditor, type AccessState, type SaveStatus } from './useFileEditor'
import { ViewToggle } from './ViewToggle'
import './editor.css'

const CodeEditor = lazy(() => import('../../editor/CodeEditor'))

const LANGUAGE_LABELS: Record<string, string> = { shellscript: 'shell', docker: 'dockerfile' }

interface EditorPaneProps {
  change: FileChange
  source: EditSource
  /** Kept mounted (with its unsaved edits) while the diff is shown instead. */
  hidden: boolean
  dirty: boolean
  onDirtyChange: (dirty: boolean) => void
  onSaved: (message: string) => void
  onShowDiff: () => void
}

export function EditorPane({ change, source, hidden, dirty, onDirtyChange, onSaved, onShowDiff }: EditorPaneProps) {
  const path = change.path
  const controller = useRef<EditorController | null>(null)
  const editor = useFileEditor({ source, change, controller, onSaved })
  const language = languageFor(path)
  const local = source.kind === 'local'

  useShortcuts('file', { 'file.save': editor.save }, !hidden)

  const reportDirty = useRef(onDirtyChange)
  useEffect(() => {
    reportDirty.current = onDirtyChange
  })
  useEffect(() => () => reportDirty.current(false), [])

  return (
    <div className="editor-pane" hidden={hidden}>
      <div className="diff-toolbar editor-toolbar">
        <span className="path">
          <SplitPath path={path} />
          {dirty && <span className="dirty-mark" title="Unsaved changes" aria-label="unsaved changes" />}
        </span>
        <span className="editor-meta">{language ? (LANGUAGE_LABELS[language] ?? language) : 'plain text'}</span>
        {source.kind === 'github' && <BranchLabel access={editor.access} />}
        <button type="button" className="toolbar-toggle" onClick={editor.revert} disabled={!dirty || editor.busy} title="Undo every change since the last save">
          <RotateCcw size={13} aria-hidden />
          revert
        </button>
        <button
          type="button"
          className="toolbar-toggle save-button"
          onClick={editor.save}
          disabled={!editor.canSave}
          aria-keyshortcuts={isMac() ? 'Meta+S' : 'Control+S'}
          title={withShortcut(local ? 'Save to the working tree' : 'Commit to the pull request branch', 'file.save')}
        >
          <Save size={13} aria-hidden />
          {editor.busy ? 'saving…' : local ? 'save' : 'commit'} <span className="key">{isMac() ? '⌘S' : 'Ctrl+S'}</span>
        </button>
        <ViewToggle editing dirty={dirty} onChange={(editing) => !editing && onShowDiff()} />
      </div>
      {editor.access.kind === 'blocked' && (
        <p className="editor-notice warn">
          <Lock size={13} aria-hidden />
          {editor.access.reason}
        </p>
      )}
      <StatusNotice status={editor.status} local={local} folder={local ? source.root.name : ''} actions={editor} />
      {editor.load.kind === 'loading' && <p className="diff-notice muted">Loading…</p>}
      {editor.load.kind === 'unavailable' && <p className="diff-notice muted">{editor.load.message}</p>}
      {editor.load.kind === 'ready' && (
        <Suspense fallback={<p className="diff-notice muted">Loading the editor…</p>}>
          <CodeEditor
            text={editor.load.file.text}
            language={language}
            label={`Edit ${path}`}
            onReady={(ready) => {
              controller.current = ready
              if (!hidden) ready.focus()
            }}
            onDirtyChange={onDirtyChange}
            onSave={editor.save}
          />
        </Suspense>
      )}
      {editor.status.kind === 'commit-message' && editor.access.kind === 'ok' && (
        <CommitDialog path={path} target={editor.access.target} onCommit={editor.commit} onClose={editor.dismiss} />
      )}
    </div>
  )
}

function BranchLabel({ access }: { access: AccessState }) {
  if (access.kind !== 'ok') return null
  return (
    <span className="editor-meta" title={`Saving commits to ${access.target.repo.owner}/${access.target.repo.name}`}>
      → {access.target.branch}
    </span>
  )
}

interface NoticeActions {
  allowWrite: () => void
  overwrite: () => void
  reload: () => void
  dismiss: () => void
}

function StatusNotice({ status, local, folder, actions }: { status: SaveStatus; local: boolean; folder: string; actions: NoticeActions }) {
  if (status.kind === 'needs-permission') {
    return (
      <div className="editor-notice" role="alert">
        <Lock size={13} aria-hidden />
        <span>
          Rubberduck opened <strong>{folder}</strong> read-only. To save, allow it to write to the folder; your browser asks next.
        </span>
        <button type="button" onClick={actions.allowWrite}>
          <Unlock size={13} aria-hidden />
          allow writing and save
        </button>
        <button type="button" className="link" onClick={actions.dismiss}>
          not now
        </button>
      </div>
    )
  }
  if (status.kind === 'conflict') {
    return (
      <div className="editor-notice warn" role="alert">
        <CircleAlert size={13} aria-hidden />
        <span>
          {status.message} {local ? 'Reload it (your edits are replaced) or overwrite it with yours.' : 'Reload it to edit the latest version.'}
        </span>
        <button type="button" className="secondary" onClick={actions.reload}>
          reload
        </button>
        {status.canOverwrite && (
          <button type="button" className="secondary" onClick={actions.overwrite}>
            overwrite
          </button>
        )}
        <button type="button" className="link" onClick={actions.dismiss}>
          keep editing
        </button>
      </div>
    )
  }
  if (status.kind === 'error') {
    return (
      <div className="editor-notice error" role="alert">
        <CircleAlert size={13} aria-hidden />
        <span>{status.message}</span>
        <button type="button" className="link" onClick={actions.dismiss}>
          dismiss
        </button>
      </div>
    )
  }
  return null
}
