import { useState } from 'react'
import { Link } from 'react-router'
import { isFinished, matchSessions, MAX_TASK_NOTES, type ChannelTaskKind, type TaskNote } from '../../../shared/channel'
import { channelClient, useChannel } from '../../channel/client'
import { claudeDeepLink, customPrompt, linkPrompt, type LinkTarget } from '../../channel/deepLink'
import type { Note, Repo, Session } from '../../db/schema'
import { PermissionPrompt } from './PermissionPrompt'
import { TaskList } from './TaskList'
import './claude.css'

interface ClaudeActionsProps {
  session: Session
  repo: Repo
  /** Set for pull request sessions. */
  pr: { number: number; headRef: string } | null
  notes: Note[]
}

const HINT_KEY = 'skelbert.claudeLinkHintSeen'

/** "Open in Claude Code" (a deep link) and "Send to Claude" (the channel plugin), in the session header. */
export function ClaudeActions({ session, repo, pr, notes }: ClaudeActionsProps) {
  if (!repo.owner) return null
  const target: LinkTarget = { repo: `${repo.owner}/${repo.name}`, branch: pr?.headRef ?? session.branch, pr }
  return (
    <div className="claude-actions">
      <div className="row">
        <OpenInClaude target={target} />
        <SendToClaude session={session} target={target} notes={notes} />
      </div>
      <PendingPermissions sessionId={session.id!} target={target} />
    </div>
  )
}

function OpenInClaude({ target }: { target: LinkTarget }) {
  const [hintSeen, setHintSeen] = useState(() => localStorage.getItem(HINT_KEY) === '1')
  const [custom, setCustom] = useState('')
  const dismiss = () => {
    localStorage.setItem(HINT_KEY, '1')
    setHintSeen(true)
  }
  return (
    <details className="claude-menu">
      <summary className="button secondary" title="Open a new Claude Code terminal session with a prompt typed in">
        Open in Claude Code ▾
      </summary>
      <div className="claude-popover stack" role="menu">
        {!hintSeen && (
          <div className="claude-hint stack">
            <p>
              Opens a new terminal running Claude Code in your clone of <span className="mono">{target.repo}</span>, with the prompt
              typed in but not sent.
            </p>
            <ul>
              <li>Needs Claude Code installed; its link handler registers after you send a first prompt in an interactive session.</li>
              <li>The clone is the one where you last ran <span className="mono">claude</span>; with none, it opens in your home folder.</li>
              <li>
                The prompts call the Skelbert MCP tools, so <Link to="/settings#connect-claude-code">connect Claude Code</Link> first.
              </li>
            </ul>
            <button type="button" className="link" onClick={dismiss}>
              Got it
            </button>
          </div>
        )}
        <a role="menuitem" className="claude-menu-item" href={claudeDeepLink(target.repo, linkPrompt('review', target))}>
          <strong>Review with Skelbert</strong>
          <span className="muted">Review the {target.pr ? 'pull request' : 'branch'} and add notes here</span>
        </a>
        <a role="menuitem" className="claude-menu-item" href={claudeDeepLink(target.repo, linkPrompt('fix', target))}>
          <strong>Fix accepted notes</strong>
          <span className="muted">Fix open notes, run tests, resolve each with a reply</span>
        </a>
        <div className="claude-menu-item stack">
          <strong>Custom…</strong>
          <textarea rows={3} value={custom} placeholder="What should Claude do?" onChange={(e) => setCustom(e.target.value)} />
          <a
            className={custom.trim() ? 'button secondary' : 'button secondary disabled'}
            aria-disabled={!custom.trim()}
            href={custom.trim() ? claudeDeepLink(target.repo, customPrompt(custom, target)) : undefined}
          >
            Open with this prompt
          </a>
        </div>
      </div>
    </details>
  )
}

const KIND_LABELS: Record<ChannelTaskKind, string> = { review: 'Review', fix: 'Fix accepted notes', custom: 'Custom message' }

const toTaskNote = (note: Note): TaskNote => ({
  id: note.id!,
  path: note.path,
  line: note.anchor.line,
  severity: note.severity,
  title: note.title,
  body: note.body,
})

function SendToClaude({ session, target, notes }: { session: Session; target: LinkTarget; notes: Note[] }) {
  const { status, state } = useChannel()
  const matches = matchSessions(state.sessions, target.repo, target.branch)
  const connected = matches.filter((s) => s.connected)
  const [picked, setPicked] = useState<string | null>(null)
  const channelId = picked && matches.some((s) => s.id === picked) ? picked : (connected[0]?.id ?? null)
  const [kind, setKind] = useState<ChannelTaskKind>('review')
  const [message, setMessage] = useState('')
  const [included, setIncluded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const openNotes = notes.filter((note) => note.status === 'open' && note.id)
  const tasks = state.tasks.filter((task) => task.sessionId === session.id)
  const latest = tasks[0]

  const toggle = (id: string) =>
    setIncluded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else if (next.size < MAX_TASK_NOTES) next.add(id)
      return next
    })

  const send = async () => {
    if (!channelId) return
    setBusy(true)
    setError(null)
    try {
      await channelClient.sendTask(channelId, {
        kind,
        target: { repo: target.repo, sessionId: session.id, ...(target.pr ? { pr: target.pr.number, branch: target.pr.headRef } : { branch: target.branch }) },
        ...(kind === 'custom' ? { message, notes: openNotes.filter((n) => included.has(n.id!)).map(toTaskNote) } : {}),
      })
      if (kind === 'custom') {
        setMessage('')
        setIncluded(new Set())
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const chip = latest && !isFinished(latest.state) ? `Claude: ${latest.state}` : connected.length > 0 ? `${connected.length} connected` : null

  return (
    <details className="claude-menu">
      <summary className="button secondary" title="Send a task to a running Claude Code session (research preview)">
        Send to Claude ▾{chip && <span className={`claude-chip state-${latest && !isFinished(latest.state) ? latest.state : 'idle'}`}>{chip}</span>}
      </summary>
      <div className="claude-popover stack">
        <div className="row">
          <strong>Send to Claude</strong>
          <span className="badge">research preview</span>
          <span className="spacer" />
          <Link to="/settings#claude-channel">Setup</Link>
        </div>
        {status === 'signedOut' ? (
          <p className="muted">
            Sign in to the sync server in <Link to="/settings#sync">Settings</Link> to send tasks.
          </p>
        ) : matches.length === 0 ? (
          <p className="muted">
            No Claude Code session for <span className="mono">{target.repo}</span> is connected. Start one in its checkout with the Skelbert
            channel (<Link to="/settings#claude-channel">setup</Link>).
            {status !== 'live' && ' Connecting to the server…'}
          </p>
        ) : (
          <>
            <fieldset className="claude-sessions">
              <legend>Session</legend>
              {matches.map((s) => (
                <label key={s.id} className={s.connected ? '' : 'muted'}>
                  <input type="radio" name="claude-session" checked={channelId === s.id} disabled={!s.connected} onChange={() => setPicked(s.id)} />
                  <span className={`claude-dot ${s.connected ? 'on' : ''}`} aria-hidden="true" /> {s.label}
                  <span className="muted mono"> {s.branch ?? 'detached'}</span>
                  {s.branch !== target.branch && <span className="muted"> (other branch)</span>}
                  {!s.connected && <span className="muted"> reconnecting…</span>}
                </label>
              ))}
            </fieldset>
            <fieldset className="claude-kinds row">
              <legend>Task</legend>
              {(Object.keys(KIND_LABELS) as ChannelTaskKind[]).map((k) => (
                <label key={k}>
                  <input type="radio" name="claude-kind" checked={kind === k} onChange={() => setKind(k)} /> {KIND_LABELS[k]}
                  {k === 'fix' && <span className="muted"> ({openNotes.length})</span>}
                </label>
              ))}
            </fieldset>
            {kind === 'custom' && (
              <div className="stack">
                <textarea rows={3} value={message} maxLength={4000} placeholder="Message for Claude" onChange={(e) => setMessage(e.target.value)} />
                {openNotes.length > 0 && (
                  <details>
                    <summary className="muted">Include notes ({included.size})</summary>
                    <ul className="claude-notes">
                      {openNotes.map((note) => (
                        <li key={note.id}>
                          <label>
                            <input type="checkbox" checked={included.has(note.id!)} onChange={() => toggle(note.id!)} />{' '}
                            <span className={`badge severity-${note.severity}`}>{note.severity}</span>{' '}
                            <span className="mono">
                              {note.path}:{note.anchor.line}
                            </span>{' '}
                            {note.title ?? note.body.slice(0, 80)}
                          </label>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
            <div className="row">
              <button type="button" disabled={!channelId || busy || (kind === 'custom' && !message.trim())} onClick={() => void send()}>
                {busy ? 'Sending…' : 'Send'}
              </button>
              {error && <span className="error">{error}</span>}
            </div>
          </>
        )}
        {tasks.length > 0 && <TaskList tasks={tasks.slice(0, 5)} sessions={state.sessions} />}
      </div>
    </details>
  )
}

/** Open permission prompts from Claude sessions working on this review, shown outside the menu. */
function PendingPermissions({ sessionId, target }: { sessionId: string; target: LinkTarget }) {
  const { state } = useChannel()
  const taskIds = new Set(state.tasks.filter((t) => t.sessionId === sessionId).map((t) => t.id))
  const channels = new Set(matchSessions(state.sessions, target.repo).map((s) => s.id))
  const pending = state.permissions.filter((p) => p.state === 'pending' && ((p.taskId && taskIds.has(p.taskId)) || channels.has(p.channelId)))
  if (pending.length === 0) return null
  return (
    <div className="stack">
      {pending.map((request) => (
        <PermissionPrompt key={`${request.channelId}:${request.requestId}`} request={request} session={state.sessions.find((s) => s.id === request.channelId)} />
      ))}
    </div>
  )
}
