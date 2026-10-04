import { useSyncExternalStore } from 'react'
import { isInstalled } from './install'

/** Chromium's install prompt event; not in the DOM typings. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export interface InstallState {
  /** Running as the installed app, or installed from this page. */
  installed: boolean
  /** The browser offered to install, so an Install button can show its prompt. */
  available: boolean
}

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable'

interface InstallDeps {
  events: Pick<Window, 'addEventListener'>
  installed: () => boolean
}

/** Holds the browser's deferred install prompt so Settings and the header can offer it. */
export class InstallPrompt {
  private snapshot: InstallState
  private deferred: BeforeInstallPromptEvent | null = null
  private readonly listeners = new Set<() => void>()

  constructor({ events, installed }: InstallDeps) {
    this.snapshot = { installed: installed(), available: false }
    events.addEventListener('beforeinstallprompt', (event) => {
      // Keep the event for our own button instead of the browser's mini-infobar.
      event.preventDefault()
      this.deferred = event as BeforeInstallPromptEvent
      this.set({ available: true })
    })
    events.addEventListener('appinstalled', () => {
      this.deferred = null
      this.set({ installed: true, available: false })
    })
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = () => this.snapshot

  private set(changes: Partial<InstallState>) {
    this.snapshot = { ...this.snapshot, ...changes }
    this.listeners.forEach((listener) => listener())
  }

  /** Shows the browser's install dialog; a prompt can be used once, so it is gone either way. */
  async prompt(): Promise<InstallOutcome> {
    const deferred = this.deferred
    if (!deferred) return 'unavailable'
    this.deferred = null
    this.set({ available: false })
    await deferred.prompt()
    const { outcome } = await deferred.userChoice
    if (outcome === 'accepted') this.set({ installed: true })
    return outcome
  }
}

let shared: InstallPrompt | null = null

/** Starts listening; call at startup, since the browser fires beforeinstallprompt early. */
export function startInstallPrompt(): InstallPrompt {
  shared ??= new InstallPrompt({ events: window, installed: isInstalled })
  return shared
}

const IDLE: InstallState = { installed: false, available: false }
const noop = () => () => undefined

export function useInstallPrompt(): InstallState & { prompt: () => Promise<InstallOutcome> } {
  const store = shared
  const state = useSyncExternalStore(store?.subscribe ?? noop, store?.getSnapshot ?? (() => IDLE))
  return { ...state, prompt: () => store?.prompt() ?? Promise.resolve('unavailable') }
}
