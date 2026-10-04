import { useSyncExternalStore } from 'react'

export interface UpdateSnapshot {
  /** A new version is installed and waits for a reload. */
  available: boolean
  /** The server refused this build; the oldest build it accepts. */
  required: string | null
  updating: boolean
}

export interface WorkerControl {
  /** Asks the server for a newer service worker; true once one is installed and waiting. */
  check: () => Promise<boolean>
  /** Activates the waiting worker; the page reloads when it takes over. */
  activate: () => Promise<void>
}

export interface UpdateDeps {
  reload: () => void
  /** When this tab last reloaded because the server refused it, so a server that keeps refusing cannot loop. */
  lastForcedReload: () => number | null
  markForcedReload: (at: number) => void
  now?: () => number
}

const FORCED_RELOAD_COOLDOWN_MS = 5 * 60_000
const FORCED_RELOAD_KEY = 'codeducky.forcedReloadAt'

/**
 * Tracks new versions of the app. A waiting version is offered in a banner; a 426 from the server
 * (this build is older than it accepts) fetches the new version and reloads without asking.
 */
export class UpdateController {
  private snapshot: UpdateSnapshot = { available: false, required: null, updating: false }
  private readonly listeners = new Set<() => void>()
  private worker: WorkerControl | null = null
  private activating = false
  private readonly deps: UpdateDeps

  constructor(deps: UpdateDeps) {
    this.deps = deps
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = () => this.snapshot

  private update(changes: Partial<UpdateSnapshot>) {
    this.snapshot = { ...this.snapshot, ...changes }
    this.listeners.forEach((listener) => listener())
  }

  attach(worker: WorkerControl) {
    this.worker = worker
  }

  needRefresh() {
    this.update({ available: true })
    if (this.snapshot.required) void this.activate()
  }

  clientOutdated(minimum: string) {
    if (this.snapshot.required) return
    this.update({ required: minimum })
    void this.force()
  }

  /** The banner's reload button. */
  async apply() {
    if (this.snapshot.available) return this.activate()
    this.update({ updating: true })
    this.deps.reload()
  }

  private async activate() {
    if (this.activating || !this.worker) return
    this.activating = true
    this.update({ updating: true })
    try {
      await this.worker.activate()
    } catch (error) {
      console.error('Could not activate the new version', error)
      this.activating = false
      this.update({ updating: false })
    }
  }

  private async force() {
    this.update({ updating: true })
    const waiting = this.snapshot.available || (await this.worker?.check().catch(() => false))
    if (waiting) return this.activate()
    const now = (this.deps.now ?? Date.now)()
    const last = this.deps.lastForcedReload()
    if (last === null || now - last > FORCED_RELOAD_COOLDOWN_MS) {
      this.deps.markForcedReload(now)
      this.deps.reload()
      return
    }
    this.update({ updating: false })
  }
}

function readForcedReload(): number | null {
  try {
    const value = Number(sessionStorage.getItem(FORCED_RELOAD_KEY))
    return value > 0 ? value : null
  } catch {
    return null
  }
}

function writeForcedReload(at: number) {
  try {
    sessionStorage.setItem(FORCED_RELOAD_KEY, String(at))
  } catch {
    // Without session storage the cooldown only lasts until the reload.
  }
}

export const updates = new UpdateController({
  reload: () => window.location.reload(),
  lastForcedReload: readForcedReload,
  markForcedReload: writeForcedReload,
})

export function useUpdates(): UpdateSnapshot {
  return useSyncExternalStore(updates.subscribe, updates.getSnapshot)
}
