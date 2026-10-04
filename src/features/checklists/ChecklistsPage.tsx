import { useLiveQuery } from 'dexie-react-hooks'
import { Braces, Download, FileText, Folder, Globe, ListChecks, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { useState } from 'react'
import { createChecklist, deleteChecklist } from '../../db/checklists'
import { db } from '../../db/db'
import { repoLabel } from '../../db/repos'
import type { Checklist, ChecklistScope } from '../../db/schema'
import type { FileKind } from '../../fs/pickers'
import { StatusBar, type StatusHint } from '../../app/chrome'
import { GithubIcon } from '../../ui/GithubIcon'
import { PageHeader } from '../../ui/PageHeader'
import { Panel } from '../../ui/Panel'
import { ChecklistEditor } from './ChecklistEditor'
import { RequiredTag } from './RequiredTag'
import { exportChecklists, importChecklistFile } from './checklistFiles'

const scopeValue = (scope: ChecklistScope) => String(scope)
const parseScope = (value: string): ChecklistScope => (value === 'global' ? 'global' : value)
const EDIT_HINTS: StatusHint[] = [{ keys: '↵', label: 'new item' }]

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
  const exportAll = (kind: FileKind) => run(async () => ((await exportChecklists(checklists, kind, 'rubberduck-checklists')) ? 'Exported.' : null))

  const groups: { scope: ChecklistScope; lists: Checklist[] }[] = [
    { scope: 'global', lists: checklists.filter((list) => list.scope === 'global') },
    ...repos
      .map((repo) => ({ scope: repo.id!, lists: checklists.filter((list) => list.scope === repo.id) }))
      .filter((group) => group.lists.length > 0),
  ]

  const editingList = checklists.find((list) => list.id === editing)
  const repoOf = (value: ChecklistScope) => (value === 'global' ? undefined : repos.find((candidate) => candidate.id === value))

  return (
    <section className="page narrow stack">
      <StatusBar mode="checklists" hints={editingList ? EDIT_HINTS : undefined}>
        <span className="strong">
          {checklists.length} {checklists.length === 1 ? 'checklist' : 'checklists'}
        </span>
        {editingList && <span>editing {editingList.title}</span>}
      </StatusBar>
      <PageHeader icon={ListChecks} title="checklists">
        <p>Global checklists apply to every repo. Repo checklists apply to that repo only.</p>
      </PageHeader>
      <div className="row">
        <select className="scope-select" value={scopeValue(scope)} aria-label="Scope" onChange={(event) => setScope(parseScope(event.target.value))}>
          <option value="global">Global</option>
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repoLabel(repo)}
            </option>
          ))}
        </select>
        <button type="button" onClick={create}>
          <Plus size={13} aria-hidden />
          new checklist
        </button>
        <button type="button" className="secondary" onClick={importFile}>
          <Upload size={13} aria-hidden />
          import…
        </button>
        {checklists.length > 0 && (
          <>
            <button type="button" className="secondary" onClick={() => exportAll('json')}>
              <Download size={13} aria-hidden />
              export all (json)
            </button>
            <button type="button" className="secondary" onClick={() => exportAll('markdown')}>
              <Download size={13} aria-hidden />
              export all (markdown)
            </button>
          </>
        )}
      </div>
      {message && <p className={message.error ? 'error' : 'ok'}>{message.text}</p>}
      {groups.map((group) => (
        <Panel
          key={scopeValue(group.scope)}
          icon={group.scope === 'global' ? Globe : repoOf(group.scope)?.owner ? GithubIcon : Folder}
          title={group.scope === 'global' ? 'global' : scopeName(group.scope)}
        >
          {group.lists.length === 0 && <p>None yet.</p>}
          {group.lists.map((list) =>
            editing === list.id ? (
              <ChecklistEditor key={list.id} checklist={list} onDone={() => setEditing(null)} />
            ) : (
              <article key={list.id} className="checklist-card">
                <div className="checklist-actions">
                  <strong>{list.title}</strong>
                  {list.required && <RequiredTag />}
                  <span className="muted">
                    {list.items.length} {list.items.length === 1 ? 'item' : 'items'}
                  </span>
                  <span className="spacer" />
                  <button type="button" className="link" onClick={() => setEditing(list.id!)}>
                    <Pencil size={12} aria-hidden />
                    edit
                  </button>
                  <button type="button" className="link" onClick={() => exportOne(list, 'markdown')}>
                    <FileText size={12} aria-hidden />
                    .md
                  </button>
                  <button type="button" className="link" onClick={() => exportOne(list, 'json')}>
                    <Braces size={12} aria-hidden />
                    .json
                  </button>
                  <button
                    type="button"
                    className="link danger"
                    onClick={() => window.confirm(`Delete "${list.title}"?`) && deleteChecklist(db, list.id!)}
                  >
                    <Trash2 size={12} aria-hidden />
                    delete
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
        </Panel>
      ))}
    </section>
  )
}
