import type { Note, Session } from '../db/schema'
import { fenceFor } from './fence'
import { compareNotes, countNotes } from './summary'

export { fenceFor }

export interface ReportChecklist {
  title: string
  items: { text: string; checked: boolean }[]
}

export interface ReportInput {
  repoName: string
  baseBranch: string
  session: Session
  files?: { path: string; viewed: boolean }[]
  notes: Note[]
  checklists: ReportChecklist[]
}

export const formatTimestamp = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export function noteExcerpt(note: Note): string {
  const { line, before, text, after } = note.anchor
  const first = line - before.length
  const rows = [...before, text, ...after]
  const width = String(first + rows.length - 1).length
  return rows
    .map((row, i) => `${first + i === line ? '>' : ' '} ${String(first + i).padStart(width)} | ${row}`.trimEnd())
    .join('\n')
}

function summaryLines({ session, baseBranch, files, notes }: ReportInput): string[] {
  const counts = countNotes(notes)
  const statuses = (['open', 'resolved', 'suggested', 'dismissed'] as const)
    .filter((status) => counts.byStatus[status] > 0)
    .map((status) => `${counts.byStatus[status]} ${status}`)
  if (counts.possiblyResolved > 0) statuses.push(`${counts.possiblyResolved} possibly resolved`)
  const severities = (['blocker', 'issue', 'suggestion', 'nit'] as const)
    .filter((severity) => counts.bySeverity[severity] > 0)
    .map((severity) => `${counts.bySeverity[severity]} ${severity}`)
  const lines = [
    `- Branch: \`${session.branch}\` against \`origin/${baseBranch}\``,
    `- Head: \`${session.headSha.slice(0, 7)}\`, merge base \`${session.baseSha.slice(0, 7)}\``,
    `- Started: ${formatTimestamp(session.startedAt)}${session.status === 'archived' ? ' (archived)' : ''}`,
  ]
  if (files) {
    const viewed = files.filter((file) => file.viewed).length
    lines.push(`- Files: ${plural(files.length, 'file')} changed, ${viewed} of ${files.length} viewed`)
  }
  lines.push(
    `- Notes: ${plural(counts.total, 'note')}${statuses.length ? ` (${statuses.join(', ')})` : ''}` +
      (severities.length ? `; ${severities.join(', ')}` : ''),
  )
  return lines
}

function checklistSection(checklists: ReportChecklist[]): string[] {
  if (checklists.length === 0) return []
  const lines = ['', '## Checklists']
  for (const checklist of checklists) {
    const done = checklist.items.filter((item) => item.checked).length
    lines.push('', `### ${checklist.title} (${done}/${checklist.items.length})`, '')
    for (const item of checklist.items) lines.push(`- [${item.checked ? 'x' : ' '}] ${item.text}`)
  }
  return lines
}

function noteHeading(note: Note): string {
  const where = note.anchorLost
    ? `last seen at line ${note.anchor.line}`
    : `line ${note.anchor.line}${note.anchor.side === 'old' ? ' (base)' : ''}`
  const status = note.anchorLost && note.status === 'open' ? 'open, possibly resolved' : note.status
  return `**${note.severity}** · ${status} · ${where}${SOURCE_LABELS[note.source]}`
}

const SOURCE_LABELS: Record<Note['source'], string> = { me: '', claude: ' · from Claude', mcp: ' · from MCP' }

/** The reply that closed a note, as a quote under it. */
function resolutionLines(note: Note): string[] {
  if (!note.resolution) return []
  const { by, text, at } = note.resolution
  const quoted = text.trim().split('\n').map((line) => (line ? `> ${line}` : '>'))
  return ['', `> **Resolved by ${by}** · ${formatTimestamp(at)}`, '>', ...quoted]
}

function notesSection(notes: Note[]): string[] {
  const lines = ['', '## Notes']
  if (notes.length === 0) return [...lines, '', 'No notes.']
  let path: string | null = null
  for (const note of [...notes].sort(compareNotes)) {
    if (note.path !== path) {
      path = note.path
      lines.push('', `### \`${path}\``)
    }
    const excerpt = noteExcerpt(note)
    const fence = fenceFor(excerpt)
    lines.push('', noteHeading(note), '', note.body.trim() || '_No text._', '', fence, excerpt, fence, ...resolutionLines(note))
  }
  return lines
}

/** Suggestions (from Claude or MCP) count only once accepted; pending and dismissed ones stay out of the report. */
export const isReportable = (note: Note) => note.status !== 'suggested' && note.status !== 'dismissed'

export function buildReport(report: ReportInput): string {
  const input = { ...report, notes: report.notes.filter(isReportable) }
  return [
    `# Review: ${input.repoName} · ${input.session.branch}`,
    '',
    ...summaryLines(input),
    ...checklistSection(input.checklists),
    ...notesSection(input.notes),
    '',
  ].join('\n')
}

export function reportFileName(repoName: string, session: Session): string {
  const slug = `${repoName}-${session.branch}`.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-')
  return `review-${slug}-${new Date(session.startedAt).toISOString().slice(0, 10)}.md`
}
