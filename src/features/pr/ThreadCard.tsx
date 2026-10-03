import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { errorMessage } from '../../github/errors'
import type { ReviewThread } from '../../github/threads'
import { isMac } from '../../keys/tokens'
import { Markdown } from '../notes/Markdown'
import { timeAgo } from './time'
import './pr.css'

export interface ThreadActions {
  focusedId: string | null
  /** When the focus last moved, so jumping to the same thread again scrolls it back into view. */
  focusAt: number
  replyingId: string | null
  onReplyingChange: (id: string | null) => void
  onFocus: (thread: ReviewThread) => void
  reply: (thread: ReviewThread, body: string) => Promise<void>
  setResolved: (thread: ReviewThread, resolved: boolean) => Promise<void>
}

interface ThreadCardProps {
  thread: ReviewThread
  actions: ThreadActions
  /** Shown for outdated and file-level threads, which are not on a line of the diff. */
  showWhere?: boolean
}

function whereLabel(thread: ReviewThread): string {
  if (thread.fileLevel) return 'On the file'
  const line = thread.line ?? thread.originalLine
  return `${thread.isOutdated ? 'Outdated, was ' : ''}line ${line ?? '?'}${thread.side === 'old' ? ' (base)' : ''}`
}

export function ThreadCard({ thread, actions, showWhere }: ThreadCardProps) {
  const focused = actions.focusedId === thread.id
  const replying = actions.replyingId === thread.id
  const [expanded, setExpanded] = useState(!thread.isResolved)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const open = expanded || focused || replying
  const first = thread.comments[0]
  const url = thread.comments[thread.comments.length - 1]?.url ?? first?.url

  const toggleResolved = async () => {
    setBusy(true)
    setError(null)
    try {
      await actions.setResolved(thread, !thread.isResolved)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const classes = ['thread-card', thread.isResolved && 'resolved', thread.isOutdated && 'outdated', focused && 'focused'].filter(Boolean).join(' ')
  return (
    <article className={classes} id={`thread-${thread.id}`} onClick={() => actions.onFocus(thread)} aria-label={`Review thread by ${first?.author ?? 'unknown'}`}>
      <header className="row">
        <button type="button" className="link thread-toggle" aria-expanded={open} onClick={() => setExpanded(!open)}>
          {open ? '▾' : '▸'} {first?.author ?? 'unknown'}
        </button>
        <span className="muted">
          {thread.comments.length} {thread.comments.length === 1 ? 'comment' : 'comments'}
        </span>
        {showWhere && <span className="muted mono">{whereLabel(thread)}</span>}
        {thread.isOutdated && <span className="badge muted">outdated</span>}
        {thread.isResolved && <span className="badge resolved-badge">resolved{thread.resolvedBy ? ` by ${thread.resolvedBy}` : ''}</span>}
        {thread.comments.some((comment) => comment.pending) && <span className="badge pending-badge">pending</span>}
        <span className="spacer" />
        {thread.canReply && (
          <button type="button" className="link" title="Reply (Shift+R)" onClick={() => actions.onReplyingChange(thread.id)}>
            Reply
          </button>
        )}
        {(thread.isResolved ? thread.canUnresolve : thread.canResolve) && (
          <button type="button" className="link" disabled={busy} title="Resolve or unresolve (Shift+X)" onClick={toggleResolved}>
            {thread.isResolved ? 'Unresolve' : 'Resolve'}
          </button>
        )}
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="muted">
            GitHub
          </a>
        )}
      </header>
      {!open && first && <p className="thread-snippet muted">{first.body.split('\n').find((line) => line.trim()) ?? ''}</p>}
      {open &&
        thread.comments.map((comment) => (
          <section key={comment.id} className="thread-comment">
            <div className="thread-comment-meta">
              <strong>{comment.author}</strong> <span className="muted">{timeAgo(comment.createdAt)}</span>
              {comment.pending && <span className="badge pending-badge">pending</span>}
            </div>
            <Markdown text={comment.body} />
          </section>
        ))}
      {replying && (
        <ReplyEditor
          onCancel={() => actions.onReplyingChange(null)}
          onSubmit={async (body) => {
            await actions.reply(thread, body)
            actions.onReplyingChange(null)
          }}
        />
      )}
      {error && <p className="error">{error}</p>}
    </article>
  )
}

function ReplyEditor({ onSubmit, onCancel }: { onSubmit: (body: string) => Promise<void>; onCancel: () => void }) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => textarea.current?.focus(), [])

  const submit = async () => {
    if (!body.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(body.trim())
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const save = event.key === 'Enter' && (event.metaKey || event.ctrlKey)
    if (!save && event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (save) void submit()
    else onCancel()
  }
  return (
    <div className="note-editor thread-reply" onKeyDown={onKeyDown} onClick={(event) => event.stopPropagation()}>
      <textarea ref={textarea} rows={3} value={body} placeholder="Reply on GitHub (markdown)" aria-label="Reply" onChange={(event) => setBody(event.target.value)} />
      <div className="row">
        <span className="muted">Posts to GitHub right away.</span>
        <span className="spacer" />
        <span className="muted editor-keys" aria-hidden="true">
          <kbd>{isMac() ? '⌘' : 'Ctrl'}</kbd>+<kbd>Enter</kbd> to send, <kbd>Esc</kbd> to cancel
        </span>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" disabled={!body.trim() || busy} onClick={submit}>
          {busy ? 'Sending…' : 'Reply'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
