import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { NOTE_SEVERITIES, type NoteSeverity } from '../../db/schema'
import { isMac } from '../../keys/tokens'

export interface NoteDraft {
  body: string
  severity: NoteSeverity
}

interface NoteEditorProps {
  initial?: NoteDraft
  submitLabel: string
  onSubmit: (draft: NoteDraft) => void
  onCancel: () => void
}

export function NoteEditor({ initial, submitLabel, onSubmit, onCancel }: NoteEditorProps) {
  const [body, setBody] = useState(initial?.body ?? '')
  const [severity, setSeverity] = useState<NoteSeverity>(initial?.severity ?? 'suggestion')
  const canSubmit = body.trim().length > 0
  const textarea = useRef<HTMLTextAreaElement>(null)

  // When editing, start with the caret after the existing text.
  useEffect(() => {
    const element = textarea.current
    if (element) element.setSelectionRange(element.value.length, element.value.length)
  }, [])

  const submit = () => canSubmit && onSubmit({ body: body.trim(), severity })
  // Handled here rather than by the global dispatcher; stopPropagation keeps it from also
  // blurring or cancelling anything else.
  const onKeyDown = (event: KeyboardEvent) => {
    const save = event.key === 'Enter' && (event.metaKey || event.ctrlKey)
    if (!save && event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (save) submit()
    else onCancel()
  }

  return (
    <div className="note-editor" onKeyDown={onKeyDown}>
      <textarea
        ref={textarea}
        autoFocus
        rows={3}
        value={body}
        placeholder="Leave a note (markdown)"
        aria-label="Note"
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="row">
        <select value={severity} aria-label="Severity" onChange={(event) => setSeverity(event.target.value as NoteSeverity)}>
          {NOTE_SEVERITIES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <span className="muted editor-keys" aria-hidden="true">
          <kbd>{isMac() ? '⌘' : 'Ctrl'}</kbd>+<kbd>Enter</kbd> to save, <kbd>Esc</kbd> to cancel
        </span>
        <button type="button" className="secondary" onClick={onCancel} aria-keyshortcuts="Escape">
          Cancel
        </button>
        <button type="button" disabled={!canSubmit} onClick={submit} aria-keyshortcuts="Meta+Enter Control+Enter">
          {submitLabel}
        </button>
      </div>
    </div>
  )
}
