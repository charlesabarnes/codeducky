import { describe, expect, it } from 'vitest'
import { resolveSequence } from '../../src/keys/sequence'

const sequences = new Map([
  ['line.next', [['j']]],
  ['tab.notes', [['g', 'n']]],
  ['tab.files', [['g', 'f']]],
  ['side.old', [['h'], ['ArrowLeft']]],
])

describe('resolveSequence', () => {
  it('matches single keys and alternatives', () => {
    expect(resolveSequence(['j'], sequences)).toEqual({ kind: 'match', ids: ['line.next'] })
    expect(resolveSequence(['ArrowLeft'], sequences)).toEqual({ kind: 'match', ids: ['side.old'] })
  })

  it('waits on a prefix, then matches the full sequence', () => {
    expect(resolveSequence(['g'], sequences)).toEqual({ kind: 'prefix' })
    expect(resolveSequence(['g', 'n'], sequences)).toEqual({ kind: 'match', ids: ['tab.notes'] })
    expect(resolveSequence(['g', 'f'], sequences)).toEqual({ kind: 'match', ids: ['tab.files'] })
  })

  it('reports no match', () => {
    expect(resolveSequence(['g', 'x'], sequences)).toEqual({ kind: 'none' })
    expect(resolveSequence(['q'], sequences)).toEqual({ kind: 'none' })
  })
})
