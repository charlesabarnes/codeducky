import { useSyncExternalStore } from 'react'
import { readJson, writeJson } from '../app/storage'

export const BADGE_SOURCES = ['off', 'notes', 'requests'] as const
export type BadgeSource = (typeof BADGE_SOURCES)[number]

/** This device's badge and notification choices; notification permission is per browser, so they do not sync. */
export interface PresencePrefs {
  badge: BadgeSource
  /** Opted in to notifications; the browser permission is checked separately. */
  notifications: boolean
  notifyTasks: boolean
  notifyRequests: boolean
}

type StoredPrefs = Partial<Record<keyof PresencePrefs, unknown>> | null

export const DEFAULT_PREFS: PresencePrefs = { badge: 'notes', notifications: false, notifyTasks: true, notifyRequests: true }

export const PREFS_KEY = 'codeducky.presence'

/** Keeps the known values and falls back to the default for anything missing or unknown. */
export function prefsOf(stored: StoredPrefs): PresencePrefs {
  const flag = (key: 'notifications' | 'notifyTasks' | 'notifyRequests') => {
    const value = stored?.[key]
    return typeof value === 'boolean' ? value : DEFAULT_PREFS[key]
  }
  return {
    badge: BADGE_SOURCES.find((source) => source === stored?.badge) ?? DEFAULT_PREFS.badge,
    notifications: flag('notifications'),
    notifyTasks: flag('notifyTasks'),
    notifyRequests: flag('notifyRequests'),
  }
}

interface PrefsDeps {
  read: () => StoredPrefs
  write: (prefs: PresencePrefs) => void
  /** Window events, for another window of the app changing the prefs. */
  events?: Pick<Window, 'addEventListener'>
}

export class PresencePrefsStore {
  private snapshot: PresencePrefs
  private readonly listeners = new Set<() => void>()
  private readonly deps: PrefsDeps

  constructor(deps: PrefsDeps) {
    this.deps = deps
    this.snapshot = prefsOf(deps.read())
    deps.events?.addEventListener('storage', (event: StorageEvent) => {
      if (event.key !== PREFS_KEY) return
      this.snapshot = prefsOf(deps.read())
      this.emit()
    })
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = () => this.snapshot

  private emit() {
    this.listeners.forEach((listener) => listener())
  }

  update(changes: Partial<PresencePrefs>) {
    this.snapshot = { ...this.snapshot, ...changes }
    this.deps.write(this.snapshot)
    this.emit()
  }
}

export const presencePrefs = new PresencePrefsStore({
  read: () => (typeof localStorage === 'undefined' ? null : readJson(PREFS_KEY)),
  write: (prefs) => void writeJson(PREFS_KEY, prefs),
  events: typeof window === 'undefined' ? undefined : window,
})

export function usePresencePrefs(): PresencePrefs {
  return useSyncExternalStore(presencePrefs.subscribe, presencePrefs.getSnapshot)
}
