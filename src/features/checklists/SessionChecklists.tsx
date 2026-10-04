import { Link } from 'react-router'
import { setChecked } from '../../db/checklists'
import { db } from '../../db/db'
import { RequiredTag } from './RequiredTag'
import { useChecklistProgress } from './useChecklistProgress'

interface SessionChecklistsProps {
  sessionId: string
  repoId: string
  readOnly?: boolean
}

export function SessionChecklists({ sessionId, repoId, readOnly }: SessionChecklistsProps) {
  const data = useChecklistProgress(sessionId, repoId)
  if (!data) return null
  const { lists, checked } = data
  if (lists.length === 0) {
    return (
      <p className="muted panel-message">
        No checklists for this repo. <Link to="/checklists">Create one</Link>.
      </p>
    )
  }
  return (
    <div className="session-checklists stack">
      {lists.map((list) => (
        <section key={list.id}>
          <h3 className="checklist-heading">
            <strong>{list.title}</strong>
            {list.required && <RequiredTag />}
            <span className="muted">
              {list.items.filter((item) => checked.has(item.id)).length}/{list.items.length}
            </span>
          </h3>
          <ul className="checklist-items">
            {list.items.map((item) => (
              <li key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={checked.has(item.id)}
                    onChange={(event) => setChecked(db, sessionId, item.id, event.target.checked)}
                  />
                  <span>{item.text}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!readOnly && (
        <Link to="/checklists" className="muted">
          manage checklists
        </Link>
      )}
    </div>
  )
}
