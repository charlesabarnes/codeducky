import { Check, ChevronDown, ChevronRight, ExternalLink, Reply, RotateCcw } from 'lucide-react'
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
      <header className="note-head">
        <button type="button" className="link thread-toggle" aria-expanded={open} onClick={() => setExpanded(!open)}>
          {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          {first?.author ?? 'unknown'}
        </button>
        <span className="muted">
          {thread.comments.length} {thread.comments.length === 1 ? 'comment' : 'comments'}
        </span>
        {showWhere && <span className="muted">{whereLabel(thread)}</span>}
        {thread.isOutdated && <span className="badge">outdated</span>}
        {thread.isResolved && <span className="badge resolved-badge">resolved{thread.resolvedBy ? ` by ${thread.resolvedBy}` : ''}</span>}
        {thread.comments.some((comment) => comment.pending) && <span className="badge pending-badge">pending</span>}
        <span className="spacer" />
        {thread.canReply && (
          <button type="button" className="link" title="Reply (Shift+R)" onClick={() => actions.onReplyingChange(thread.id)}>
            <Reply size={12} aria-hidden />
            reply <span className="key">R</span>
          </button>
        )}
        {(thread.isResolved ? thread.canUnresolve : thread.canResolve) && (
          <button type="button" className="link" disabled={busy} title="Resolve or unresolve (Shift+X)" onClick={toggleResolved}>
            {thread.isResolved ? <RotateCcw size={12} aria-hidden /> : <Check size={12} aria-hidden />}
            {thread.isResolved ? 'unresolve' : 'resolve'} <span className="key">X</span>
          </button>
        )}
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="icon-link muted">
            github
            <ExternalLink size={11} aria-hidden />
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
      <div className="note-editor-bar">
        <span className="muted">posts to github right away</span>
        <span className="spacer" />
        <button type="button" className="link" disabled={!body.trim() || busy} onClick={submit}>
          <span className="key">{isMac() ? '⌘↵' : 'Ctrl+↵'}</span> {busy ? 'sending…' : 'reply'}
        </button>
        <button type="button" className="link" onClick={onCancel}>
          <span className="key">esc</span> cancel
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
