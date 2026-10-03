import { useState } from 'react'
import { newItem, saveChecklist } from '../../db/checklists'
import { db } from '../../db/db'
import type { Checklist, ChecklistItem } from '../../db/schema'

interface ChecklistEditorProps {
  checklist: Checklist
  onDone: () => void
}

export function ChecklistEditor({ checklist, onDone }: ChecklistEditorProps) {
  const [title, setTitle] = useState(checklist.title)
  const [items, setItems] = useState<ChecklistItem[]>(checklist.items.length ? checklist.items : [newItem('')])

  const update = (index: number, text: string) =>
    setItems((current) => current.map((item, i) => (i === index ? { ...item, text } : item)))
  const remove = (index: number) => setItems((current) => current.filter((_, i) => i !== index))
  const move = (index: number, offset: number) =>
    setItems((current) => {
      const next = [...current]
      const [item] = next.splice(index, 1)
      next.splice(index + offset, 0, item!)
      return next
    })

  const save = async () => {
    const kept = items.map((item) => ({ ...item, text: item.text.trim() })).filter((item) => item.text)
    await saveChecklist(db, { ...checklist, title: title.trim() || 'Untitled', items: kept })
    onDone()
  }

  return (
    <div className="stack checklist-editor" style={{ gap: '0.5rem' }}>
      <input value={title} aria-label="Checklist title" onChange={(event) => setTitle(event.target.value)} />
      <ol className="stack" style={{ gap: '0.25rem' }}>
        {items.map((item, index) => (
          <li key={item.id} className="row">
            <input
              value={item.text}
              aria-label={`Item ${index + 1}`}
              placeholder="Item"
              onChange={(event) => update(index, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setItems((current) => [...current.slice(0, index + 1), newItem(''), ...current.slice(index + 1)])
              }}
            />
            <button type="button" className="secondary" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">
              ↑
            </button>
            <button
              type="button"
              className="secondary"
              disabled={index === items.length - 1}
              onClick={() => move(index, 1)}
              aria-label="Move down"
            >
              ↓
            </button>
            <button type="button" className="secondary" onClick={() => remove(index)} aria-label="Remove item">
              ✕
            </button>
          </li>
        ))}
      </ol>
      <div className="row">
        <button type="button" className="secondary" onClick={() => setItems((current) => [...current, newItem('')])}>
          Add item
        </button>
        <span className="spacer" />
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
        <button type="button" onClick={save}>
          Save
        </button>
      </div>
    </div>
  )
}
