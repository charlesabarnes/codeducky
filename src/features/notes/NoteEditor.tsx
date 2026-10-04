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
      <div className="note-editor-bar">
        <div className="severity-picker" role="group" aria-label="Severity">
          {NOTE_SEVERITIES.map((option) => (
            <button key={option} type="button" aria-pressed={severity === option} onClick={() => setSeverity(option)}>
              {option}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button type="button" className="link" disabled={!canSubmit} onClick={submit} aria-keyshortcuts="Meta+Enter Control+Enter">
          <span className="key">{isMac() ? '⌘↵' : 'Ctrl+↵'}</span> {submitLabel}
        </button>
        <button type="button" className="link" onClick={onCancel} aria-keyshortcuts="Escape">
          <span className="key">esc</span> cancel
        </button>
      </div>
    </div>
  )
}
