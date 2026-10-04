import { ALWAYS_ON, KEYMAP, parseSequence, SCOPE_PRIORITY, type KeyBinding, type KeyScope } from './keymap'
import { resolveSequence } from './sequence'

/** Return false to decline, so a lower-priority handler (or the browser) gets the key. */
export type ShortcutHandler = (id: string) => boolean | void

interface Registration {
  scope: KeyScope
  ids: ReadonlySet<string>
  handle: ShortcutHandler
  order: number
}

export interface KeyInput {
  /** From eventToken; null for keys we never handle. */
  token: string | null
  /** The event target is a text field (see isEditableTarget). */
  editable: boolean
  /** The event target handles every key itself (see ownsKeys), so nothing is dispatched. */
  owned?: boolean
  repeat: boolean
  now: number
}

export const SEQUENCE_TIMEOUT_MS = 1500

/**
 * Routes key tokens to registered handlers. Owns the registry of live handlers (the current
 * context), the pending multi-key sequence, and the rules for suppressing keys while typing.
 */
export class ShortcutDispatcher {
  private enabled = true
  private registrations = new Set<Registration>()
  private buffer: string[] = []
  private lastAt = 0
  private counter = 0
  private readonly bindings: ReadonlyMap<string, KeyBinding>
  private readonly timeout: number

  constructor(bindings: readonly KeyBinding[] = KEYMAP, timeout = SEQUENCE_TIMEOUT_MS) {
    this.bindings = new Map(bindings.map((binding) => [binding.id, binding]))
    this.timeout = timeout
  }

  /** When off, only Esc, Cmd/Ctrl+Enter and Cmd/Ctrl+S work (WCAG 2.1.4: character shortcuts can be turned off). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.buffer = []
  }

  register(scope: KeyScope, ids: Iterable<string>, handle: ShortcutHandler): () => void {
    const registration = { scope, ids: new Set(ids), handle, order: this.counter++ }
    this.registrations.add(registration)
    return () => {
      this.registrations.delete(registration)
    }
  }

  /** Ids with at least one live handler: what the help overlay lists. */
  activeIds(): Set<string> {
    const ids = new Set<string>()
    for (const registration of this.registrations) for (const id of registration.ids) ids.add(id)
    return ids
  }

  get pending(): readonly string[] {
    return this.buffer
  }

  reset(): void {
    this.buffer = []
  }

  /** Returns true when the key was consumed (the caller should preventDefault). */
  handle({ token, editable, owned = false, repeat, now }: KeyInput): boolean {
    if (owned) this.buffer = []
    if (token === null || owned) return false
    const always = ALWAYS_ON.has(token)
    if ((editable || !this.enabled) && !always) {
      this.buffer = []
      return false
    }
    if (this.buffer.length > 0 && now - this.lastAt > this.timeout) this.buffer = []

    const sequences = this.activeSequences()
    let typed = [...this.buffer, token]
    let result = resolveSequence(typed, sequences)
    if (result.kind === 'none' && this.buffer.length > 0) {
      typed = [token]
      result = resolveSequence(typed, sequences)
    }
    if (result.kind === 'prefix') {
      this.buffer = typed
      this.lastAt = now
      return true
    }
    this.buffer = []
    if (result.kind === 'none') return false

    const candidates = result.ids
      .flatMap((id) => [...this.registrations].filter((r) => r.ids.has(id)).map((registration) => ({ id, registration })))
      .sort(
        (a, b) =>
          SCOPE_PRIORITY[b.registration.scope] - SCOPE_PRIORITY[a.registration.scope] ||
          b.registration.order - a.registration.order,
      )
    for (const { id, registration } of candidates) {
      if (repeat && !this.bindings.get(id)?.repeat) return true
      if (registration.handle(id) !== false) return true
    }
    return false
  }

  private activeSequences(): Map<string, string[][]> {
    const sequences = new Map<string, string[][]>()
    for (const id of this.activeIds()) {
      const binding = this.bindings.get(id)
      if (!binding || binding.docOnly) continue
      sequences.set(id, binding.keys.map(parseSequence))
    }
    return sequences
  }
}
