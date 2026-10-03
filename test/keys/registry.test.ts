import { describe, expect, it } from 'vitest'
import { describeKeys, helpGroups } from '../../src/keys/help'
import { BINDINGS, KEYMAP, parseSequence } from '../../src/keys/keymap'

describe('keymap', () => {
  it('has unique ids', () => {
    expect(new Set(KEYMAP.map((binding) => binding.id)).size).toBe(KEYMAP.length)
  })

  it('never binds a browser or OS combo', () => {
    for (const binding of KEYMAP) {
      for (const keys of binding.keys) {
        for (const token of parseSequence(keys)) {
          expect(token === 'mod+Enter' || !token.includes('+'), `${binding.id}: ${token}`).toBe(true)
        }
      }
    }
  })

  it('has no ambiguous sequences among dispatched bindings', () => {
    const sequences = KEYMAP.filter((binding) => !('docOnly' in binding)).flatMap((binding) =>
      binding.keys.map((keys) => ({ id: binding.id, tokens: parseSequence(keys) })),
    )
    for (const a of sequences) {
      for (const b of sequences) {
        if (a === b || a.tokens.length >= b.tokens.length) continue
        const isPrefix = a.tokens.every((token, i) => b.tokens[i] === token)
        expect(isPrefix, `${a.id} is a prefix of ${b.id}`).toBe(false)
      }
    }
  })

  it('covers the agreed scheme', () => {
    const keysOf = (id: string) => BINDINGS.get(id)?.keys
    expect(keysOf('line.next')).toEqual(['j'])
    expect(keysOf('file.next')).toEqual([']'])
    expect(keysOf('hunk.next')).toEqual(['n'])
    expect(keysOf('change.next')).toEqual(['J'])
    expect(keysOf('tab.notes')).toEqual(['g n'])
    expect(keysOf('files.filter')).toEqual(['/'])
    expect(keysOf('help')).toEqual(['?'])
    for (const id of ['note.comment', 'note.edit', 'note.resolve', 'note.accept', 'note.dismiss', 'file.viewed', 'view.mode']) {
      expect(BINDINGS.has(id)).toBe(true)
    }
  })
})

describe('helpGroups', () => {
  it('lists only active bindings, in group order, without hidden ones', () => {
    const groups = helpGroups(new Set(['help', 'escape', 'line.next', 'file.viewed']))
    expect(groups.map((group) => group.group)).toEqual(['Navigation', 'View', 'General'])
    expect(groups.flatMap((group) => group.bindings.map((binding) => binding.id))).toEqual(['line.next', 'file.viewed', 'help'])
  })

  it('shows editor keys alongside commenting', () => {
    const ids = helpGroups(new Set(['note.comment'])).flatMap((group) => group.bindings.map((binding) => binding.id))
    expect(ids).toEqual(['note.comment', 'editor.save', 'editor.cancel'])
  })
})

describe('describeKeys', () => {
  it('spells out sequences, shift and alternatives', () => {
    expect(describeKeys(BINDINGS.get('tab.notes')!, true)).toBe('g then n')
    expect(describeKeys(BINDINGS.get('change.next')!, true)).toBe('Shift+J')
    expect(describeKeys(BINDINGS.get('side.old')!, true)).toBe('h or ←')
    expect(describeKeys(BINDINGS.get('editor.save')!, true)).toBe('⌘+Enter')
    expect(describeKeys(BINDINGS.get('editor.save')!, false)).toBe('Ctrl+Enter')
  })
})
