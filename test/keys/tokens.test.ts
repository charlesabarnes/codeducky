import { describe, expect, it } from 'vitest'
import { eventToken, isEditableTarget, keyCaps, ownsKeys, type KeyLike } from '../../src/keys/tokens'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
})

describe('eventToken', () => {
  it('maps letters by shift state, not caps lock', () => {
    expect(eventToken(key('j'))).toBe('j')
    expect(eventToken(key('J', { shiftKey: true }))).toBe('J')
    expect(eventToken(key('J'))).toBe('j')
  })

  it('keeps punctuation as typed', () => {
    expect(eventToken(key('?', { shiftKey: true }))).toBe('?')
    expect(eventToken(key('/'))).toBe('/')
    expect(eventToken(key(']'))).toBe(']')
  })

  it('leaves Ctrl, Cmd and Alt combos to the browser', () => {
    expect(eventToken(key('j', { ctrlKey: true }))).toBeNull()
    expect(eventToken(key('c', { metaKey: true }))).toBeNull()
    expect(eventToken(key('∆', { altKey: true }))).toBeNull()
    expect(eventToken(key('ArrowLeft', { metaKey: true }))).toBeNull()
    expect(eventToken(key('ArrowLeft', { shiftKey: true }))).toBeNull()
  })

  it('treats AltGr characters as plain keys', () => {
    expect(eventToken(key('[', { ctrlKey: true, altKey: true, getModifierState: (m) => m === 'AltGraph' }))).toBe('[')
  })

  it('recognises Cmd or Ctrl+Enter', () => {
    expect(eventToken(key('Enter', { metaKey: true }))).toBe('mod+Enter')
    expect(eventToken(key('Enter', { ctrlKey: true }))).toBe('mod+Enter')
    expect(eventToken(key('Enter'))).toBeNull()
  })

  it('recognises Cmd or Ctrl+S, but not with Shift or Alt', () => {
    expect(eventToken(key('s', { metaKey: true }))).toBe('mod+s')
    expect(eventToken(key('s', { ctrlKey: true }))).toBe('mod+s')
    expect(eventToken(key('S', { metaKey: true, shiftKey: true }))).toBeNull()
    expect(eventToken(key('s', { metaKey: true, altKey: true }))).toBeNull()
    expect(eventToken(key('s'))).toBe('s')
  })

  it('ignores space, modifiers on their own and IME composition', () => {
    expect(eventToken(key(' '))).toBeNull()
    expect(eventToken(key('Shift', { shiftKey: true }))).toBeNull()
    expect(eventToken(key('j', { isComposing: true }))).toBeNull()
  })
})

describe('isEditableTarget', () => {
  it('suppresses text fields, selects and contenteditable', () => {
    expect(isEditableTarget({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(isEditableTarget({ tagName: 'INPUT', type: 'search' })).toBe(true)
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('does not suppress buttons, checkboxes or the page', () => {
    expect(isEditableTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isEditableTarget({ tagName: 'BODY', isContentEditable: false })).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe('ownsKeys', () => {
  const element = (insideEditor: boolean) => ({ closest: (selector: string) => (insideEditor && selector === '[data-own-keys]' ? {} : null) })

  it('claims keys inside the code editor, its search panel included', () => {
    expect(ownsKeys(element(true))).toBe(true)
  })

  it('leaves everything else to the shortcuts', () => {
    expect(ownsKeys(element(false))).toBe(false)
    expect(ownsKeys({ tagName: 'INPUT' })).toBe(false)
    expect(ownsKeys(null)).toBe(false)
  })
})

describe('keyCaps', () => {
  it('spells modifier combos for each platform', () => {
    expect(keyCaps('mod+s', true)).toEqual(['⌘', 'S'])
    expect(keyCaps('mod+s', false)).toEqual(['Ctrl', 'S'])
    expect(keyCaps('mod+shift+z', true)).toEqual(['⌘', 'Shift', 'Z'])
    expect(keyCaps('shift+Tab', true)).toEqual(['Shift', 'Tab'])
    expect(keyCaps('mod+Enter', false)).toEqual(['Ctrl', 'Enter'])
  })

  it('keeps single keys as they were', () => {
    expect(keyCaps('j', true)).toEqual(['j'])
    expect(keyCaps('E', true)).toEqual(['Shift', 'E'])
    expect(keyCaps('Escape', true)).toEqual(['Esc'])
  })
})
