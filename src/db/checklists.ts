import type { ChecklistDraft } from '../checklists/format'
import type { SkelbertDb } from './db'
import type { Checklist, ChecklistScope } from './schema'

export const newItem = (text: string) => ({ id: crypto.randomUUID(), text })

export async function createChecklist(db: SkelbertDb, scope: ChecklistScope, draft: ChecklistDraft): Promise<string> {
  return db.checklists.add({ scope, title: draft.title, items: draft.items.map(newItem) }) as Promise<string>
}

export async function importChecklists(db: SkelbertDb, scope: ChecklistScope, drafts: ChecklistDraft[]): Promise<string[]> {
  return db.transaction('rw', db.checklists, () => Promise.all(drafts.map((draft) => createChecklist(db, scope, draft))))
}

export async function saveChecklist(db: SkelbertDb, checklist: Checklist): Promise<void> {
  await db.checklists.put(checklist)
}

export async function deleteChecklist(db: SkelbertDb, id: string): Promise<void> {
  await db.checklists.delete(id)
}

export async function applicableChecklists(db: SkelbertDb, repoId: string): Promise<Checklist[]> {
  const lists = await db.checklists.where('scope').anyOf('global', repoId).toArray()
  return lists.sort((a, b) => (a.scope === b.scope ? a.title.localeCompare(b.title) : a.scope === 'global' ? -1 : 1))
}

export async function setChecked(db: SkelbertDb, sessionId: string, itemId: string, checked: boolean): Promise<void> {
  await db.checklistState.put({ sessionId, itemId, checked })
}

export async function checkedItems(db: SkelbertDb, sessionId: string): Promise<Set<string>> {
  const states = await db.checklistState.where({ sessionId }).toArray()
  return new Set(states.filter((state) => state.checked).map((state) => state.itemId))
}

export const toDraft = (checklist: Checklist): ChecklistDraft => ({
  title: checklist.title,
  items: checklist.items.map((item) => item.text),
})
