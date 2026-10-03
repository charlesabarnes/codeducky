import type { Note, NoteSeverity } from '../db/schema'

const ORDER: readonly NoteSeverity[] = ['nit', 'suggestion', 'issue', 'blocker']

/** The most severe of the given notes' severities, or null when there are none. */
export function highestSeverity(notes: readonly Note[]): NoteSeverity | null {
  let best = -1
  for (const note of notes) {
    const rank = ORDER.indexOf(note.severity)
    if (rank < best) best = rank
  }
  return best < 0 ? null : ORDER[best]!
}

/** Whether any open note blocks the push. */
export function hasBlocker(notes: readonly Note[]): boolean {
  return notes.some((note) => note.status === 'open' && note.severity === 'blocker')
}
