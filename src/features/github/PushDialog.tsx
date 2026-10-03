import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Note, Session } from '../../db/schema'
import { errorMessage } from '../../github/errors'
import type { PlacedNote, UnplacedNote } from '../../github/push'
import { pushErrorHint, type PushPreview, type PushResult } from '../../github/pushReview'
import type { PushTarget } from './pushTargets'
import type { PullRequest } from '../../github/types'
import { NoteBadges } from '../notes/NoteBadges'
import './github.css'

type State =
  | { status: 'loading' }
  | { status: 'no-pr' }
  | { status: 'error'; message: string }
  | { status: 'ready'; preview: PushPreview }
  | { status: 'pushed'; pr: PullRequest; result: PushResult; comments: number; inBody: number }

interface PushDialogProps {
  session: Session
  notes: Note[]
  target: PushTarget
  onClose: () => void
}

const short = (sha: string) => sha.slice(0, 7)
const alreadyPushed = (note: Note) => note.github?.reviewId !== undefined

function defaultSelection(preview: PushPreview): Set<string> {
  const { placed, unplaced } = preview.placement
  return new Set(
    [...placed, ...unplaced].flatMap(({ note }) => (note.id !== undefined && !alreadyPushed(note) ? [note.id] : [])),
  )
}

export function PushDialog({ session, notes, target, onClose }: PushDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [state, setState] = useState<State>({ status: 'loading' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pushing, setPushing] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)
  const [initialNotes] = useState(notes)
  const [initialTarget] = useState(target)

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<State> => {
      const lookup = await initialTarget.prepare(initialNotes)
      if (lookup.kind === 'no-pr') return { status: 'no-pr' }
      return { status: 'ready', preview: lookup.preview }
    }
    load()
      .then((next) => {
        if (cancelled) return
        setState(next)
        if (next.status === 'ready') setSelected(defaultSelection(next.preview))
      })
      .catch((error: unknown) => !cancelled && setState({ status: 'error', message: errorMessage(error) }))
    return () => {
      cancelled = true
    }
  }, [initialTarget, initialNotes])

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const push = async (preview: PushPreview) => {
    const isSelected = ({ note }: { note: Note }) => note.id !== undefined && selected.has(note.id)
    const placed = preview.placement.placed.filter(isSelected)
    const bodyNotes = preview.placement.unplaced.filter(isSelected).map((entry) => entry.note)
    setPushing(true)
    setPushError(null)
    try {
      const result = await target.push(preview, { placed, bodyNotes })
      setState({ status: 'pushed', pr: preview.pr, result, comments: placed.length, inBody: bodyNotes.length })
    } catch (error) {
      setPushError(pushErrorHint(error) ?? errorMessage(error))
    } finally {
      setPushing(false)
    }
  }

  return (
    <dialog ref={dialog} className="push-dialog" onClose={onClose} aria-labelledby="push-title">
      <form method="dialog">
        <h2 id="push-title">Push notes to GitHub</h2>
        <Body state={state} selected={selected} onToggle={toggle} branch={session.branch} />
        {pushError && <p className="error">{pushError}</p>}
        <footer>
          {state.status === 'ready' && (
            <span className="muted">{target.notice}</span>
          )}
          <span className="spacer" />
          <button type="submit" className="secondary">
            {state.status === 'pushed' ? 'Close' : 'Cancel'}
          </button>
          {state.status === 'ready' && (
            <button
              type="button"
              disabled={pushing || selected.size === 0}
              onClick={() => push(state.preview)}
            >
              {pushing ? 'Creating…' : 'Create pending review'}
            </button>
          )}
        </footer>
      </form>
    </dialog>
  )
}

interface BodyProps {
  state: State
  selected: Set<string>
  onToggle: (id: string) => void
  branch: string
}

function Body({ state, selected, onToggle, branch }: BodyProps) {
  switch (state.status) {
    case 'loading':
      return <p className="muted">Looking for the pull request…</p>
    case 'error':
      return <p className="error">{state.message}</p>
    case 'no-pr':
      return (
        <p>
          No open pull request has <span className="mono">{branch}</span> as its head branch. Push the branch and open a
          pull request on GitHub, then try again.
        </p>
      )
    case 'pushed':
      return (
        <div className="stack" style={{ gap: '0.5rem' }}>
          <p className="ok">
            Pending review created with {state.comments} inline {state.comments === 1 ? 'comment' : 'comments'}
            {state.inBody > 0 && ` and ${state.inBody} ${state.inBody === 1 ? 'note' : 'notes'} in the review body`}.
          </p>
          <p>
            <a href={state.result.review.htmlUrl || state.pr.htmlUrl} target="_blank" rel="noreferrer">
              Open #{state.pr.number} on GitHub
            </a>{' '}
            to check and submit it.
          </p>
        </div>
      )
    case 'ready':
      return <Preview preview={state.preview} selected={selected} onToggle={onToggle} />
  }
}

function Preview({ preview, selected, onToggle }: { preview: PushPreview; selected: Set<string>; onToggle: (id: string) => void }) {
  const { pr, placement, localHead } = preview
  const total = placement.placed.length + placement.unplaced.length
  return (
    <>
      <p>
        <a href={pr.htmlUrl} target="_blank" rel="noreferrer">
          #{pr.number} {pr.title}
        </a>
        {pr.draft && <span className="badge muted"> draft</span>}
      </p>
      {localHead !== pr.headSha && (
        <p className="notice">
          Your local HEAD ({short(localHead)}) is not the pull request head ({short(pr.headSha)}). Notes were re-anchored
          onto the pull request's diff; check where they land, and push your branch if it is ahead.
        </p>
      )}
      {total === 0 && <p className="muted">There are no open notes to push.</p>}
      {placement.placed.length > 0 && (
        <NoteSection title={`Inline comments (${placement.placed.length})`}>
          {placement.placed.map((entry) => (
            <PlacedRow key={entry.note.id} entry={entry} selected={selected} onToggle={onToggle} />
          ))}
        </NoteSection>
      )}
      {placement.unplaced.length > 0 && (
        <NoteSection title={`Not on the diff (${placement.unplaced.length})`} hint="Ticked notes go in the review body, with an excerpt.">
          {placement.unplaced.map((entry) => (
            <UnplacedRow key={entry.note.id} entry={entry} selected={selected} onToggle={onToggle} />
          ))}
        </NoteSection>
      )}
    </>
  )
}

function NoteSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="stack" style={{ gap: '0.35rem' }}>
      <h3>{title}</h3>
      {hint && <p className="muted">{hint}</p>}
      <ul className="push-notes">{children}</ul>
    </section>
  )
}

interface RowProps<T> {
  entry: T
  selected: Set<string>
  onToggle: (id: string) => void
}

function NoteRow({ note, where, extra, selected, onToggle }: { note: Note; where: ReactNode; extra?: ReactNode } & Omit<RowProps<unknown>, 'entry'>) {
  const id = note.id!
  return (
    <li>
      <label>
        <input type="checkbox" checked={selected.has(id)} onChange={() => onToggle(id)} />
        <span className="push-note-text">
          <span className="row" style={{ gap: '0.25rem' }}>
            <NoteBadges note={note} />
            {extra}
          </span>
          <span className="note-where mono">{where}</span>
          <span className="note-snippet">{note.body.split('\n')[0] || 'No text.'}</span>
        </span>
      </label>
    </li>
  )
}

function PlacedRow({ entry, selected, onToggle }: RowProps<PlacedNote>) {
  const { note, comment, exact } = entry
  const moved = comment.line !== note.anchor.line
  const where = (
    <>
      {comment.path}:{comment.line}
      {comment.side === 'LEFT' && ' (base)'}
      {moved && ` (line ${note.anchor.line} locally)`}
    </>
  )
  const extra = !exact && (
    <span className="badge muted" title="The surrounding lines differ from the note's anchor">
      nearest match
    </span>
  )
  return <NoteRow note={note} where={where} extra={extra} selected={selected} onToggle={onToggle} />
}

function UnplacedRow({ entry, selected, onToggle }: RowProps<UnplacedNote>) {
  const { note, reason } = entry
  const where = (
    <>
      {note.path}:{note.anchor.line} · {reason}
    </>
  )
  return <NoteRow note={note} where={where} selected={selected} onToggle={onToggle} />
}
