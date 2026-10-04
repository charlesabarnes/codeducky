import type { ChecklistDraft } from '../checklists/format'
import type { RubberduckDb } from './db'
import type { Checklist, ChecklistScope } from './schema'

export const newItem = (text: string) => ({ id: crypto.randomUUID(), text })

export async function createChecklist(db: RubberduckDb, scope: ChecklistScope, draft: ChecklistDraft): Promise<string> {
  const checklist: Checklist = { scope, title: draft.title, items: draft.items.map(newItem) }
  if (draft.required) checklist.required = true
  return db.checklists.add(checklist) as Promise<string>
}

export async function importChecklists(db: RubberduckDb, scope: ChecklistScope, drafts: ChecklistDraft[]): Promise<string[]> {
  return db.transaction('rw', db.checklists, () => Promise.all(drafts.map((draft) => createChecklist(db, scope, draft))))
}

export async function saveChecklist(db: RubberduckDb, checklist: Checklist): Promise<void> {
  await db.checklists.put(checklist)
}

export async function deleteChecklist(db: RubberduckDb, id: string): Promise<void> {
  await db.checklists.delete(id)
}

export async function applicableChecklists(db: RubberduckDb, repoId: string): Promise<Checklist[]> {
  const lists = await db.checklists.where('scope').anyOf('global', repoId).toArray()
  return lists.sort((a, b) => (a.scope === b.scope ? a.title.localeCompare(b.title) : a.scope === 'global' ? -1 : 1))
}

export async function setChecked(db: RubberduckDb, sessionId: string, itemId: string, checked: boolean): Promise<void> {
  await db.checklistState.put({ sessionId, itemId, checked })
}

export async function checkedItems(db: RubberduckDb, sessionId: string): Promise<Set<string>> {
  const states = await db.checklistState.where({ sessionId }).toArray()
  return new Set(states.filter((state) => state.checked).map((state) => state.itemId))
}

export const toDraft = (checklist: Checklist): ChecklistDraft => ({
  title: checklist.title,
  items: checklist.items.map((item) => item.text),
  ...(checklist.required ? { required: true } : {}),
})
