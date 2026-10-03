import { describe, expect, it } from 'vitest'
import type { Note } from '../../src/db/schema'
import { carryOverNotes } from '../../src/review/carryOver'

const note = (id: number, status: Note['status']): Note => ({
  id,
  sessionId: 1,
  path: 'a',
  anchor: { line: 1, side: 'new', text: 'x', before: [], after: [] },
  body: `note ${id}`,
  severity: 'nit',
  status,
  source: 'me',
  createdAt: 5,
  updatedAt: 5,
  github: { commentId: 9 },
})

describe('carryOverNotes', () => {
  it('copies open notes into the new session without ids or GitHub links', () => {
    const carried = carryOverNotes([note(1, 'open'), note(2, 'resolved'), note(3, 'dismissed')], 2, 100)
    expect(carried).toEqual([
      {
        sessionId: 2,
        path: 'a',
        anchor: { line: 1, side: 'new', text: 'x', before: [], after: [] },
        body: 'note 1',
        severity: 'nit',
        status: 'open',
        source: 'me',
        createdAt: 5,
        updatedAt: 100,
        carriedFrom: 1,
      },
    ])
  })
})
