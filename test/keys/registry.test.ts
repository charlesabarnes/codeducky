import { describe, expect, it } from 'vitest'
import { describeKeys, helpGroups } from '../../src/keys/help'
import { BINDINGS, KEYMAP, parseSequence } from '../../src/keys/keymap'

describe('keymap', () => {
  it('has unique ids', () => {
    expect(new Set(KEYMAP.map((binding) => binding.id)).size).toBe(KEYMAP.length)
  })

  it('never dispatches a browser or OS combo other than Cmd/Ctrl+Enter and Cmd/Ctrl+S (Shift+↑/↓ grow a line selection)', () => {
    const ours = new Set(['mod+Enter', 'mod+s', 'shift+ArrowUp', 'shift+ArrowDown'])
    for (const binding of KEYMAP.filter((candidate) => !('docOnly' in candidate))) {
      for (const keys of binding.keys) {
        for (const token of parseSequence(keys)) {
          expect(ours.has(token) || !token.includes('+'), `${binding.id}: ${token}`).toBe(true)
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
    expect(keysOf('line.extendNext')).toEqual(['shift+ArrowDown'])
    expect(keysOf('line.extendPrev')).toEqual(['shift+ArrowUp'])
    expect(keysOf('tab.notes')).toEqual(['g n'])
    expect(keysOf('files.filter')).toEqual(['/'])
    expect(keysOf('help')).toEqual(['?'])
    expect(keysOf('nav.inbox')).toEqual(['g i'])
    expect(keysOf('thread.next')).toEqual(['t'])
    expect(keysOf('thread.prev')).toEqual(['T'])
    expect(keysOf('thread.reply')).toEqual(['R'])
    expect(keysOf('thread.resolve')).toEqual(['X'])
    expect(keysOf('inbox.open')).toEqual(['o'])
    for (const id of ['note.comment', 'note.edit', 'note.resolve', 'note.accept', 'note.dismiss', 'file.viewed', 'view.mode']) {
      expect(BINDINGS.has(id)).toBe(true)
    }
  })

  it('gives pull request keys their own keys in a session', () => {
    const sessionIds = ['file.edit', 'line.next', 'line.prev', 'line.extendNext', 'line.extendPrev', 'change.next', 'change.prev', 'hunk.next', 'hunk.prev', 'file.next', 'file.prev', 'note.next', 'note.prev', 'side.old', 'side.new', 'gap.expand', 'note.comment', 'note.edit', 'note.resolve', 'note.accept', 'note.dismiss', 'file.viewed', 'view.mode', 'view.whitespace', 'files.filter', 'tab.files', 'tab.notes', 'tab.checklists', 'thread.next', 'thread.prev', 'thread.reply', 'thread.resolve', 'tab.conversation', 'nav.inbox', 'help']
    const keys = sessionIds.flatMap((id) => BINDINGS.get(id)!.keys.map((key) => ({ id, key })))
    for (const { id, key } of keys) {
      expect(keys.filter((other) => other.key === key).map((other) => other.id), `${id}: ${key}`).toEqual([id])
    }
  })
})

describe('helpGroups', () => {
  it('lists only active bindings, in group order, without hidden ones', () => {
    const groups = helpGroups(new Set(['help', 'escape', 'line.next', 'file.viewed']))
    expect(groups.map((group) => group.group)).toEqual(['Navigation', 'View', 'General'])
    expect(groups.flatMap((group) => group.bindings.map((binding) => binding.id))).toEqual(['line.next', 'file.viewed', 'help'])
  })

  it('lists the file editor’s own keys while it is open', () => {
    const ids = helpGroups(new Set(['file.edit', 'file.save'])).flatMap((group) => group.bindings.map((binding) => binding.id))
    expect(ids).toEqual(['file.edit', 'file.save', 'file.find', 'file.undo', 'file.redo', 'file.indent', 'file.outdent', 'file.leave'])
    expect(helpGroups(new Set(['file.edit'])).flatMap((group) => group.bindings.map((binding) => binding.id))).toEqual(['file.edit'])
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
    expect(describeKeys(BINDINGS.get('file.save')!, true)).toBe('⌘+S')
    expect(describeKeys(BINDINGS.get('file.edit')!, true)).toBe('Shift+E')
    expect(describeKeys(BINDINGS.get('file.leave')!, true)).toBe('Esc then Tab')
  })
})
