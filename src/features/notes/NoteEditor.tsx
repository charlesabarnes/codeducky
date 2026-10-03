import { useState, type KeyboardEvent } from 'react'
import { NOTE_SEVERITIES, type NoteSeverity } from '../../db/schema'

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

  const submit = () => canSubmit && onSubmit({ body: body.trim(), severity })
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
    if (event.key === 'Escape') onCancel()
  }

  return (
    <div className="note-editor" onKeyDown={onKeyDown}>
      <textarea
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
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" disabled={!canSubmit} onClick={submit}>
          {submitLabel}
        </button>
      </div>
    </div>
  )
}
