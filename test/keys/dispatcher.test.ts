import { describe, expect, it, vi } from 'vitest'
import { ShortcutDispatcher } from '../../src/keys/dispatcher'

const press = (
  dispatcher: ShortcutDispatcher,
  token: string | null,
  extra: { editable?: boolean; owned?: boolean; repeat?: boolean; now?: number } = {},
) => dispatcher.handle({ token, editable: extra.editable ?? false, owned: extra.owned, repeat: extra.repeat ?? false, now: extra.now ?? 0 })

describe('ShortcutDispatcher', () => {
  it('runs the handler for an active binding only', () => {
    const dispatcher = new ShortcutDispatcher()
    const handler = vi.fn()
    expect(press(dispatcher, 'j')).toBe(false)
    const off = dispatcher.register('diff', ['line.next'], handler)
    expect(press(dispatcher, 'j')).toBe(true)
    expect(handler).toHaveBeenCalledWith('line.next')
    off()
    expect(press(dispatcher, 'j')).toBe(false)
    expect(dispatcher.activeIds().size).toBe(0)
  })

  it('suppresses shortcuts while typing, except Esc and Cmd+Enter', () => {
    const dispatcher = new ShortcutDispatcher()
    const handler = vi.fn()
    dispatcher.register('global', ['help', 'escape', 'line.next'], handler)
    expect(press(dispatcher, 'j', { editable: true })).toBe(false)
    expect(press(dispatcher, '?', { editable: true })).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    expect(press(dispatcher, 'Escape', { editable: true })).toBe(true)
    expect(handler).toHaveBeenCalledWith('escape')
  })

  it('fires nothing, not even Esc or Cmd+S, inside the file editor', () => {
    const dispatcher = new ShortcutDispatcher()
    const handler = vi.fn()
    dispatcher.register('global', ['help', 'escape'], handler)
    dispatcher.register('session', ['file.next', 'file.edit', 'tab.notes'], handler)
    dispatcher.register('file', ['file.save'], handler)
    for (const token of ['j', ']', 'E', '?', 'Escape', 'mod+s', 'mod+Enter', 'g']) {
      expect(press(dispatcher, token, { editable: true, owned: true }), token).toBe(false)
    }
    expect(handler).not.toHaveBeenCalled()
    expect(dispatcher.pending).toEqual([])
  })

  it('a key in the editor drops a sequence started outside it', () => {
    const dispatcher = new ShortcutDispatcher()
    const handler = vi.fn()
    dispatcher.register('session', ['tab.notes'], handler)
    press(dispatcher, 'g')
    press(dispatcher, 'x', { editable: true, owned: true })
    expect(press(dispatcher, 'n')).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('saves with Cmd+S from a text field outside the editor, only while the editor is open', () => {
    const dispatcher = new ShortcutDispatcher()
    const save = vi.fn()
    expect(press(dispatcher, 'mod+s', { editable: true })).toBe(false)
    const off = dispatcher.register('file', ['file.save'], save)
    expect(press(dispatcher, 'mod+s', { editable: true })).toBe(true)
    expect(save).toHaveBeenCalledWith('file.save')
    off()
    expect(press(dispatcher, 'mod+s')).toBe(false)
  })

  it('handles two-key sequences and gives up after a timeout', () => {
    const dispatcher = new ShortcutDispatcher(undefined, 1000)
    const handler = vi.fn()
    dispatcher.register('session', ['tab.notes', 'note.comment'], handler)
    expect(press(dispatcher, 'g', { now: 0 })).toBe(true)
    expect(dispatcher.pending).toEqual(['g'])
    expect(press(dispatcher, 'n', { now: 500 })).toBe(true)
    expect(handler).toHaveBeenLastCalledWith('tab.notes')

    press(dispatcher, 'g', { now: 2000 })
    expect(press(dispatcher, 'c', { now: 3500 })).toBe(true)
    expect(handler).toHaveBeenLastCalledWith('note.comment')
  })

  it('falls back to the latest key when a sequence breaks', () => {
    const dispatcher = new ShortcutDispatcher()
    const handler = vi.fn()
    dispatcher.register('diff', ['tab.files', 'line.next'], handler)
    press(dispatcher, 'g')
    expect(press(dispatcher, 'j')).toBe(true)
    expect(handler).toHaveBeenCalledWith('line.next')
    expect(dispatcher.pending).toEqual([])
  })

  it('typing in a field clears a pending sequence', () => {
    const dispatcher = new ShortcutDispatcher()
    const handler = vi.fn()
    dispatcher.register('session', ['tab.notes'], handler)
    press(dispatcher, 'g')
    press(dispatcher, 'x', { editable: true })
    expect(press(dispatcher, 'n')).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('prefers the more specific scope and lets handlers decline', () => {
    const dispatcher = new ShortcutDispatcher()
    const calls: string[] = []
    dispatcher.register('diff', ['hunk.next'], () => {
      calls.push('diff')
      return false
    })
    dispatcher.register('file', ['hunk.next'], () => {
      calls.push('file')
    })
    expect(press(dispatcher, 'n')).toBe(true)
    expect(calls).toEqual(['diff', 'file'])
  })

  it('reports unhandled when every handler declines, so the browser keeps the key', () => {
    const dispatcher = new ShortcutDispatcher()
    dispatcher.register('split', ['side.old'], () => false)
    expect(press(dispatcher, 'ArrowLeft')).toBe(false)
  })

  it('only repeats bindings that allow it', () => {
    const dispatcher = new ShortcutDispatcher()
    const handler = vi.fn()
    dispatcher.register('diff', ['line.next', 'note.comment'], handler)
    press(dispatcher, 'j', { repeat: true })
    press(dispatcher, 'c', { repeat: true })
    expect(handler.mock.calls).toEqual([['line.next']])
  })

  it('can turn character shortcuts off', () => {
    const dispatcher = new ShortcutDispatcher()
    const handler = vi.fn()
    dispatcher.register('global', ['help', 'escape'], handler)
    dispatcher.setEnabled(false)
    expect(press(dispatcher, '?')).toBe(false)
    expect(press(dispatcher, 'Escape')).toBe(true)
  })

  it('ignores keys with no token', () => {
    const dispatcher = new ShortcutDispatcher()
    dispatcher.register('session', ['tab.notes'], vi.fn())
    press(dispatcher, 'g')
    expect(press(dispatcher, null)).toBe(false)
    expect(dispatcher.pending).toEqual(['g'])
  })
})
