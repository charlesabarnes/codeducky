import { describe, expect, it } from 'vitest'
import { eventToken, isEditableTarget, type KeyLike } from '../../src/keys/tokens'

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
