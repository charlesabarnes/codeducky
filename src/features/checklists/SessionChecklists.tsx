import { Link } from 'react-router'
import { setChecked } from '../../db/checklists'
import { db } from '../../db/db'
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
      <p className="muted" style={{ padding: '0 1rem' }}>
        No checklists for this repo. <Link to="/checklists">Create one</Link>.
      </p>
    )
  }
  return (
    <div className="session-checklists stack">
      {lists.map((list) => (
        <section key={list.id}>
          <h3>
            {list.title}{' '}
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
                  />{' '}
                  {item.text}
                </label>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!readOnly && (
        <Link to="/checklists" className="muted">
          Manage checklists
        </Link>
      )}
    </div>
  )
}
