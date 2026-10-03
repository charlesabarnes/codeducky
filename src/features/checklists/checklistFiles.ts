import { importChecklists, toDraft } from '../../db/checklists'
import { db } from '../../db/db'
import type { Checklist, ChecklistScope } from '../../db/schema'
import { openTextFile, saveTextFile, type FileKind } from '../../fs/pickers'
import { checklistsToJson, checklistsToMarkdown, parseChecklistFile } from '../../checklists/format'

const slug = (title: string) => title.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'checklist'

export async function exportChecklists(checklists: Checklist[], kind: FileKind, name: string): Promise<boolean> {
  const drafts = checklists.map(toDraft)
  const text = kind === 'json' ? checklistsToJson(drafts) : checklistsToMarkdown(drafts)
  return saveTextFile(`${slug(name)}.${kind === 'json' ? 'json' : 'md'}`, text, kind)
}

export async function importChecklistFile(scope: ChecklistScope): Promise<number> {
  const file = await openTextFile(['markdown', 'json'])
  if (!file) return 0
  const ids = await importChecklists(db, scope, parseChecklistFile(file.name, file.text))
  return ids.length
}
