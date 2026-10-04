import { describe, expect, it } from 'vitest'
import { pairId, parsePairId, parseSyncRequest, validateChange, wins } from '../../shared/sync'
import { fromWire, toWire } from '../../src/sync/records'

describe('last-write-wins', () => {
  it('takes the later write and keeps the current one on a tie', () => {
    expect(wins({ changedAt: 2, deleted: false }, { changedAt: 1, deleted: false })).toBe(true)
    expect(wins({ changedAt: 1, deleted: false }, { changedAt: 2, deleted: false })).toBe(false)
    expect(wins({ changedAt: 1, deleted: false }, { changedAt: 1, deleted: false })).toBe(false)
    expect(wins({ changedAt: 1, deleted: false }, null)).toBe(true)
  })

  it('lets a delete win a tie, but not a later edit', () => {
    expect(wins({ changedAt: 5, deleted: true }, { changedAt: 5, deleted: false })).toBe(true)
    expect(wins({ changedAt: 5, deleted: false }, { changedAt: 5, deleted: true })).toBe(false)
    expect(wins({ changedAt: 4, deleted: true }, { changedAt: 5, deleted: false })).toBe(false)
    expect(wins({ changedAt: 6, deleted: false }, { changedAt: 5, deleted: true })).toBe(true)
  })
})

describe('wire records', () => {
  it('never sends local-only fields', () => {
    const wire = toWire('repos', {
      id: 'gh:o/r',
      changedAt: 9,
      dirHandle: { kind: 'directory' },
      owner: 'o',
      name: 'r',
      folderName: 'r',
      baseBranch: 'main',
      checklistIds: [],
      lastOpenedAt: 1,
      claudeInstructions: undefined,
    })
    expect(wire).toEqual({
      kind: 'repos',
      id: 'gh:o/r',
      changedAt: 9,
      deleted: false,
      data: { owner: 'o', name: 'r', folderName: 'r', baseBranch: 'main', checklistIds: [], lastOpenedAt: 1 },
    })
  })

  it('round-trips pair-keyed records', () => {
    const row = { sessionId: 's1', path: 'a "quoted" path.ts', contentHash: 'h', viewed: true, changedAt: 3 }
    const wire = toWire('fileViews', row)
    expect(wire.id).toBe(pairId('s1', 'a "quoted" path.ts'))
    expect(parsePairId(wire.id)).toEqual(['s1', 'a "quoted" path.ts'])
    expect(validateChange(wire)).toBeNull()
    expect(fromWire(wire)).toEqual(row)
  })

  it('validates notes, including MCP resolutions', () => {
    const note = {
      kind: 'notes',
      id: 'n1',
      changedAt: 1,
      deleted: false,
      data: {
        sessionId: 's',
        path: 'a',
        anchor: { line: 1, side: 'new', text: 'x', before: [], after: [] },
        body: 'b',
        severity: 'nit',
        status: 'resolved',
        source: 'mcp',
        createdAt: 1,
        updatedAt: 1,
        resolution: { by: 'Claude Code', text: 'Fixed in abc123', at: 2 },
      },
    }
    expect(validateChange(note)).toBeNull()
    expect(validateChange({ ...note, data: { ...note.data, resolution: { by: 1 } } })).toBe('notes.resolution is invalid')
    expect(validateChange({ ...note, data: { ...note.data, source: 'robot' } })).toBe('notes.source is invalid')
    expect(validateChange({ kind: 'notes', id: 'n1', changedAt: 1, deleted: true })).toBeNull()
  })

  it('validates note ranges and still accepts single-line anchors without them', () => {
    const withAnchor = (anchor: Record<string, unknown>) => ({
      kind: 'notes',
      id: 'n1',
      changedAt: 1,
      deleted: false,
      data: { sessionId: 's', path: 'a', anchor, body: 'b', severity: 'nit', status: 'open', source: 'me', createdAt: 1, updatedAt: 1 },
    })
    const single = { line: 4, side: 'new', text: 'x', before: ['w'], after: ['y'] }
    expect(validateChange(withAnchor(single))).toBeNull()
    expect(validateChange(withAnchor({ ...single, endLine: 6, rangeText: ['x', 'y', 'z'] }))).toBeNull()
    // A line-only range from MCP, before the PWA fills in its text.
    expect(validateChange(withAnchor({ line: 4, side: 'new', text: '', before: [], after: [], endLine: 6 }))).toBeNull()
    expect(validateChange(withAnchor({ ...single, endLine: 4, rangeText: ['x'] }))).toBe('notes.anchor is invalid')
    expect(validateChange(withAnchor({ ...single, endLine: 3 }))).toBe('notes.anchor is invalid')
    expect(validateChange(withAnchor({ ...single, endLine: 5.5 }))).toBe('notes.anchor is invalid')
    expect(validateChange(withAnchor({ ...single, endLine: 6, rangeText: ['x', 'y'] }))).toBe('notes.anchor is invalid')
    expect(validateChange(withAnchor({ ...single, rangeText: ['x'] }))).toBe('notes.anchor is invalid')
    expect(validateChange(withAnchor({ ...single, endLine: '6' }))).toBe('notes.anchor is invalid')
  })

  it('splits invalid changes out of a request', () => {
    const parsed = parseSyncRequest({ cursor: 0, changes: [{ kind: 'nope', id: 'x' }, { kind: 'notes', id: 'n', changedAt: 1, deleted: true }] })
    expect(parsed).toEqual({
      cursor: 0,
      changes: [{ kind: 'notes', id: 'n', changedAt: 1, deleted: true }],
      rejected: [{ kind: 'nope', id: 'x', error: 'unknown kind: nope' }],
    })
  })
})
