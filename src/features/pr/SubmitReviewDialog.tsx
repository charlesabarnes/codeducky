import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { db } from '../../db/db'
import type { Note } from '../../db/schema'
import type { GitHubClient } from '../../github/client'
import { errorMessage } from '../../github/errors'
import type { PrSnapshot } from '../../github/prDiff'
import { placeNotes } from '../../github/push'
import { archiveWithReview, EVENT_LABEL, needsBody, reviewSummary, submitPrReview, unpushedNotes, type SubmitInput } from '../../github/prReview'
import type { PendingReview } from '../../github/threads'
import type { ReviewEvent } from '../../github/types'
import { isMac } from '../../keys/tokens'
import '../github/github.css'

const EVENTS: { event: ReviewEvent; hint: string }[] = [
  { event: 'COMMENT', hint: 'General feedback without approving.' },
  { event: 'APPROVE', hint: 'Approve merging these changes.' },
  { event: 'REQUEST_CHANGES', hint: 'Feedback that must be addressed before merging.' },
]

interface SubmitReviewDialogProps {
  sessionId: string
  gh: GitHubClient
  snapshot: PrSnapshot
  notes: Note[]
  pending: PendingReview | null
  viewer: string | null
  onClose: () => void
}

export function SubmitReviewDialog({ sessionId, gh, snapshot, notes, pending, viewer, onClose }: SubmitReviewDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const { pull, ref, files } = snapshot
  const ownPull = viewer !== null && viewer === pull.author
  const [event, setEvent] = useState<ReviewEvent>('COMMENT')
  // Your notes summed up, then whatever your pending review already says (e.g. notes that are not on the diff).
  const [body, setBody] = useState(() => [reviewSummary(notes), pending?.body.trim()].filter(Boolean).join('\n\n'))
  const toSend = useMemo(() => unpushedNotes(notes), [notes])
  const [include, setInclude] = useState(true)
  const placement = useMemo(() => placeNotes(toSend, files), [toSend, files])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const input: SubmitInput = { event, body, placement: include && toSend.length > 0 ? placement : null }
  const missingBody = needsBody(input, pending?.comments ?? 0)
  const blocked = (event === 'APPROVE' || event === 'REQUEST_CHANGES') && ownPull

  const submit = async () => {
    if (busy || missingBody || blocked) return
    setBusy(true)
    setError(null)
    try {
      const result = await submitPrReview(db, gh, ref, pull, pending, input)
      await archiveWithReview(db, sessionId, result)
      dialog.current?.close()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const onKeyDown = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key === 'Enter' && (keyEvent.metaKey || keyEvent.ctrlKey)) {
      keyEvent.preventDefault()
      void submit()
    }
  }

  return (
    <dialog ref={dialog} className="push-dialog submit-review" onClose={onClose} aria-labelledby="submit-title" onKeyDown={onKeyDown}>
      <form method="dialog">
        <h2 id="submit-title">
          Submit review on #{pull.number} {pull.title}
        </h2>
        {pending && (
          <p className="notice">
            Submits your pending review ({pending.comments} {pending.comments === 1 ? 'comment' : 'comments'} on GitHub).
          </p>
        )}
        <fieldset className="review-events">
          <legend className="sr-only">Review type</legend>
          {EVENTS.map((option) => {
            const disabled = ownPull && option.event !== 'COMMENT'
            return (
              <label key={option.event} className={disabled ? 'disabled' : undefined}>
                <input type="radio" name="event" value={option.event} checked={event === option.event} disabled={disabled} onChange={() => setEvent(option.event)} />
                <span>
                  <strong>{EVENT_LABEL[option.event]}</strong> <span className="muted">{disabled ? 'GitHub does not allow this on your own pull request.' : option.hint}</span>
                </span>
              </label>
            )
          })}
        </fieldset>
        <label className="field">
          <span>Summary</span>
          <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Review summary" />
          <small className="muted">Defaults to a summary of your open notes. Markdown.</small>
        </label>
        {toSend.length > 0 && (
          <label className="row include-notes">
            <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} />
            <span>
              Include {toSend.length} unpushed {toSend.length === 1 ? 'note' : 'notes'}: {placement.placed.length} inline
              {placement.unplaced.length > 0 && `, ${placement.unplaced.length} in the summary (not on the diff)`}
            </span>
          </label>
        )}
        {missingBody && <p className="muted">GitHub needs a summary or at least one comment for this review.</p>}
        {error && <p className="error">{error}</p>}
        <footer>
          <span className="muted">
            <kbd>{isMac() ? '⌘' : 'Ctrl'}</kbd>+<kbd>Enter</kbd> to submit. The session is archived afterwards.
          </span>
          <span className="spacer" />
          <button type="submit" className="secondary">
            Cancel
          </button>
          <button type="button" disabled={busy || missingBody || blocked} onClick={submit}>
            {busy ? 'Submitting…' : `Submit: ${EVENT_LABEL[event]}`}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
