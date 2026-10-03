import { describe, expect, it } from 'vitest'
import type { Note, NoteStatus } from '../../src/db/schema'
import { matchesStatus } from '../../src/review/summary'

const note = (status: NoteStatus): Note => ({
  sessionId: 1,
  path: 'a.ts',
  anchor: { line: 1, side: 'new', text: 'x', before: [], after: [] },
  body: '',
  severity: 'issue',
  status,
  source: 'claude',
  createdAt: 0,
  updatedAt: 0,
})

describe('matchesStatus', () => {
  it('shows open notes and Claude suggestions by default, hiding dismissed and resolved ones', () => {
    const statuses: NoteStatus[] = ['open', 'suggested', 'resolved', 'dismissed']
    expect(statuses.filter((status) => matchesStatus(note(status), 'active'))).toEqual(['open', 'suggested'])
    expect(statuses.filter((status) => matchesStatus(note(status), 'dismissed'))).toEqual(['dismissed'])
  })
})
