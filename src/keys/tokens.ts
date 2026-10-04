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

/** Cmd/Ctrl combos that are ours: Enter saves a note, S saves the file editor (and stays the browser's elsewhere). */
const MOD_KEYS: Record<string, string> = { Enter: 'mod+Enter', s: 'mod+s', S: 'mod+s' }

/**
 * Turns a keydown into a shortcut token, or null when it must be left to the browser.
 * Anything held with Ctrl, Cmd or Alt is never ours, except Cmd/Ctrl+Enter and Cmd/Ctrl+S, so
 * browser and OS combos are never stolen. AltGr characters (Ctrl+Alt on Windows layouts) count as plain.
 */
export function eventToken(event: KeyLike): string | null {
  if (event.isComposing) return null
  const { key } = event
  const mod = MOD_KEYS[key]
  if (mod && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) return mod
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

/** Inside an element that handles its own keys (the code editor), no shortcut fires, not even Esc. */
export function ownsKeys(target: unknown): boolean {
  if (!target || typeof target !== 'object' || !('closest' in target) || typeof target.closest !== 'function') return false
  return (target as Element).closest('[data-own-keys]') !== null
}

export const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const NAMED_CAPS: Record<string, string> = { Escape: 'Esc', ArrowLeft: '←', ArrowRight: '→' }

function modifierCap(modifier: string, mac: boolean): string {
  if (modifier === 'mod') return mac ? '⌘' : 'Ctrl'
  if (modifier === 'alt') return mac ? '⌥' : 'Alt'
  return 'Shift'
}

/** Key caps for one token: "J" → ["Shift", "J"], "mod+Enter" → ["⌘", "Enter"], "mod+shift+z" → ["⌘", "Shift", "Z"]. */
export function keyCaps(token: string, mac = isMac()): string[] {
  const parts = token.length > 1 ? token.split('+') : [token]
  const key = parts.pop()!
  const modifiers = parts.map((modifier) => modifierCap(modifier, mac))
  if (NAMED_CAPS[key]) return [...modifiers, NAMED_CAPS[key]]
  if (/^[A-Z]$/.test(key)) return [...modifiers, 'Shift', key]
  return [...modifiers, modifiers.length > 0 && key.length === 1 ? key.toUpperCase() : key]
}

/** A sequence as chords of key caps: "g n" → [["g"], ["n"]]. */
export function formatSequence(keys: string, mac = isMac()): string[][] {
  return parseSequence(keys).map((token) => keyCaps(token, mac))
}
