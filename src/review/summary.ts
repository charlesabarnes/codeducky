import type { Note, NoteSeverity, NoteStatus } from '../db/schema'

export interface NoteCounts {
  total: number
  possiblyResolved: number
  byStatus: Record<NoteStatus, number>
  bySeverity: Record<NoteSeverity, number>
}

export function countNotes(notes: readonly Note[]): NoteCounts {
  const counts: NoteCounts = {
    total: notes.length,
    possiblyResolved: 0,
    byStatus: { open: 0, resolved: 0, suggested: 0, dismissed: 0 },
    bySeverity: { nit: 0, suggestion: 0, issue: 0, blocker: 0 },
  }
  for (const note of notes) {
    counts.byStatus[note.status]++
    counts.bySeverity[note.severity]++
    if (note.anchorLost && note.status === 'open') counts.possiblyResolved++
  }
  return counts
}

/** Open notes per severity, worst first, for the review summary. */
export function openBySeverity(notes: readonly Note[]): [NoteSeverity, number][] {
  const open = notes.filter((note) => note.status === 'open')
  return (['blocker', 'issue', 'suggestion', 'nit'] as const)
    .map((severity): [NoteSeverity, number] => [severity, open.filter((note) => note.severity === severity).length])
    .filter(([, count]) => count > 0)
}

export type StatusFilter = 'all' | 'active' | NoteStatus | 'possibly-resolved'

export function matchesStatus(note: Note, filter: StatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return note.status === 'open' || note.status === 'suggested'
  if (filter === 'possibly-resolved') return note.status === 'open' && Boolean(note.anchorLost)
  return note.status === filter
}

const SEVERITY_RANK: Record<NoteSeverity, number> = { blocker: 0, issue: 1, suggestion: 2, nit: 4 }

export function compareNotes(a: Note, b: Note): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1
  if (Boolean(a.anchorLost) !== Boolean(b.anchorLost)) return a.anchorLost ? -1 : 1
  if (a.anchor.line !== b.anchor.line) return a.anchor.line - b.anchor.line
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
}
