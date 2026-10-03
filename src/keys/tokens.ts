import { parseSequence } from './keymap'

export interface KeyLike {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  isComposing?: boolean
  getModifierState?: (key: string) => boolean
}

const NAMED = new Set(['Escape', 'ArrowLeft', 'ArrowRight'])

/**
 * Turns a keydown into a shortcut token, or null when it must be left to the browser.
 * Anything held with Ctrl, Cmd or Alt is never ours, except Cmd/Ctrl+Enter, so browser and
 * OS combos are never stolen. AltGr characters (Ctrl+Alt on Windows layouts) count as plain.
 */
export function eventToken(event: KeyLike): string | null {
  if (event.isComposing) return null
  const { key } = event
  if (key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) return 'mod+Enter'
  const altGraph = event.getModifierState?.('AltGraph') ?? false
  if (!altGraph && (event.ctrlKey || event.metaKey || event.altKey)) return null
  if (NAMED.has(key)) return event.shiftKey && key !== 'Escape' ? null : key
  if (key.length !== 1 || key === ' ') return null
  if (/^[a-z]$/i.test(key)) return event.shiftKey ? key.toUpperCase() : key.toLowerCase()
  return key
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color', 'image'])

interface ElementLike {
  tagName?: string
  type?: string
  isContentEditable?: boolean
}

/** True for fields where keys type text: shortcuts other than Esc and Cmd+Enter are suppressed there. */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const element = target as ElementLike
  if (element.isContentEditable) return true
  const tag = element.tagName?.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((element.type ?? 'text').toLowerCase())
  return false
}

export const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Key caps for one token: "J" → ["Shift", "J"], "mod+Enter" → ["⌘", "Enter"]. */
export function keyCaps(token: string, mac = isMac()): string[] {
  if (token === 'mod+Enter') return [mac ? '⌘' : 'Ctrl', 'Enter']
  if (token === 'Escape') return ['Esc']
  if (token === 'ArrowLeft') return ['←']
  if (token === 'ArrowRight') return ['→']
  if (/^[A-Z]$/.test(token)) return ['Shift', token]
  return [token]
}

/** A sequence as chords of key caps: "g n" → [["g"], ["n"]]. */
export function formatSequence(keys: string, mac = isMac()): string[][] {
  return parseSequence(keys).map((token) => keyCaps(token, mac))
}
