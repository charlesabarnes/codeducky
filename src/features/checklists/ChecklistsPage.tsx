import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { createChecklist, deleteChecklist } from '../../db/checklists'
import { db } from '../../db/db'
import { repoLabel } from '../../db/repos'
import type { Checklist, ChecklistScope } from '../../db/schema'
import type { FileKind } from '../../fs/pickers'
import { ChecklistEditor } from './ChecklistEditor'
import { exportChecklists, importChecklistFile } from './checklistFiles'

const scopeValue = (scope: ChecklistScope) => String(scope)
const parseScope = (value: string): ChecklistScope => (value === 'global' ? 'global' : value)

export function ChecklistsPage() {
  const data = useLiveQuery(async () => ({
    checklists: await db.checklists.toArray(),
    repos: await db.repos.toArray(),
  }))
  const [scope, setScope] = useState<ChecklistScope>('global')
  const [editing, setEditing] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)

  if (!data) return <p className="page muted">Loading…</p>
  const { checklists, repos } = data
  const scopeName = (value: ChecklistScope) => {
    if (value === 'global') return 'Global'
    const repo = repos.find((candidate) => candidate.id === value)
    return repo ? repoLabel(repo) : `Repo ${value}`
  }
  const exportOne = (list: Checklist, kind: FileKind) =>
    run(async () => ((await exportChecklists([list], kind, list.title)) ? 'Exported.' : null))

  const run = async (action: () => Promise<string | null>) => {
    setMessage(null)
    try {
      const text = await action()
      if (text) setMessage({ text })
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true })
    }
  }

  const create = () =>
    run(async () => {
      setEditing(await createChecklist(db, scope, { title: 'New checklist', items: [] }))
      return null
    })
  const importFile = () =>
    run(async () => {
      const count = await importChecklistFile(scope)
      return count ? `Imported ${count} ${count === 1 ? 'checklist' : 'checklists'} into ${scopeName(scope)}.` : null
    })
  const exportAll = (kind: FileKind) => run(async () => ((await exportChecklists(checklists, kind, 'skelbert-checklists')) ? 'Exported.' : null))

  const groups: { scope: ChecklistScope; lists: Checklist[] }[] = [
    { scope: 'global', lists: checklists.filter((list) => list.scope === 'global') },
    ...repos
      .map((repo) => ({ scope: repo.id!, lists: checklists.filter((list) => list.scope === repo.id) }))
      .filter((group) => group.lists.length > 0),
  ]

  return (
    <section className="page narrow stack">
      <div>
        <h1>Checklists</h1>
        <p className="muted">Global checklists apply to every repo. Repo checklists apply to that repo only.</p>
      </div>
      <div className="row">
        <select value={scopeValue(scope)} aria-label="Scope" onChange={(event) => setScope(parseScope(event.target.value))}>
          <option value="global">Global</option>
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repoLabel(repo)}
            </option>
          ))}
        </select>
        <button type="button" onClick={create}>
          New checklist
        </button>
        <button type="button" className="secondary" onClick={importFile}>
          Import…
        </button>
        {checklists.length > 0 && (
          <>
            <button type="button" className="secondary" onClick={() => exportAll('json')}>
              Export all (JSON)
            </button>
            <button type="button" className="secondary" onClick={() => exportAll('markdown')}>
              Export all (markdown)
            </button>
          </>
        )}
      </div>
      {message && <p className={message.error ? 'error' : 'ok'}>{message.text}</p>}
      {groups.map((group) => (
        <section key={scopeValue(group.scope)} className="stack" style={{ gap: '0.75rem' }}>
          <h2>{scopeName(group.scope)}</h2>
          {group.lists.length === 0 && <p className="muted">None yet.</p>}
          {group.lists.map((list) =>
            editing === list.id ? (
              <div key={list.id} className="card">
                <ChecklistEditor checklist={list} onDone={() => setEditing(null)} />
              </div>
            ) : (
              <article key={list.id} className="card stack" style={{ gap: '0.5rem' }}>
                <div className="row">
                  <strong>{list.title}</strong>
                  <span className="muted">{list.items.length} items</span>
                  <span className="spacer" />
                  <button type="button" className="link" onClick={() => setEditing(list.id!)}>
                    Edit
                  </button>
                  <button type="button" className="link" onClick={() => exportOne(list, 'markdown')}>
                    .md
                  </button>
                  <button type="button" className="link" onClick={() => exportOne(list, 'json')}>
                    .json
                  </button>
                  <button
                    type="button"
                    className="link danger"
                    onClick={() => window.confirm(`Delete "${list.title}"?`) && deleteChecklist(db, list.id!)}
                  >
                    Delete
                  </button>
                </div>
                <ul className="checklist-preview">
                  {list.items.map((item) => (
                    <li key={item.id}>{item.text}</li>
                  ))}
                </ul>
              </article>
            ),
          )}
        </section>
      ))}
    </section>
  )
}
