export interface ChecklistDraft {
  title: string
  items: string[]
  /** Unticked items block a push through the pre-push gate. JSON files keep it; markdown does not. */
  required?: boolean
}

interface ChecklistFile {
  version: 1
  checklists: ChecklistDraft[]
}

export function checklistsToJson(checklists: ChecklistDraft[]): string {
  const file: ChecklistFile = { version: 1, checklists }
  return `${JSON.stringify(file, null, 2)}\n`
}

export function checklistsToMarkdown(checklists: ChecklistDraft[]): string {
  return checklists
    .map((checklist) => [`# ${checklist.title}`, '', ...checklist.items.map((item) => `- [ ] ${item}`)].join('\n'))
    .join('\n\n')
    .concat('\n')
}

const isDraft = (value: unknown): value is ChecklistDraft =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ChecklistDraft).title === 'string' &&
  Array.isArray((value as ChecklistDraft).items) &&
  (value as ChecklistDraft).items.every((item) => typeof item === 'string')

export function parseChecklistJson(text: string): ChecklistDraft[] {
  const parsed: unknown = JSON.parse(text)
  const list = Array.isArray(parsed) ? parsed : (parsed as Partial<ChecklistFile> | null)?.checklists
  if (!Array.isArray(list) || !list.every(isDraft)) throw new Error('Not a Code Ducky checklist file.')
  return list.map(({ title, items, required }) => ({
    title: title.trim() || 'Untitled',
    items: items.map((item) => item.trim()).filter(Boolean),
    ...(required === true ? { required } : {}),
  }))
}

const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/
const ITEM = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/

export function parseChecklistMarkdown(text: string, fallbackTitle: string): ChecklistDraft[] {
  const checklists: ChecklistDraft[] = []
  let current: ChecklistDraft | null = null
  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING.exec(line)
    if (heading) {
      current = { title: heading[1]!, items: [] }
      checklists.push(current)
      continue
    }
    const item = ITEM.exec(line)
    if (!item) continue
    if (!current) {
      current = { title: fallbackTitle, items: [] }
      checklists.push(current)
    }
    current.items.push(item[1]!)
  }
  const result = checklists.filter((checklist) => checklist.items.length > 0)
  if (result.length === 0) throw new Error('No checklist items found. Use "- [ ] item" lines.')
  return result
}

export function parseChecklistFile(name: string, text: string): ChecklistDraft[] {
  if (/\.json$/i.test(name)) return parseChecklistJson(text)
  return parseChecklistMarkdown(text, name.replace(/\.[^.]+$/, ''))
}
