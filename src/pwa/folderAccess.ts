import type { CodeDuckyDb } from '../db/db'
import { repoLabel } from '../db/repos'

export interface FolderAccess {
  repoId: string
  label: string
  handle: FileSystemDirectoryHandle
  state: PermissionState
}

type FolderDb = Pick<CodeDuckyDb, 'repos' | 'repoHandles'>

const READ: FileSystemHandlePermissionDescriptor = { mode: 'read' }

async function queryRead(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  try {
    return await handle.queryPermission(READ)
  } catch {
    return 'prompt'
  }
}

/** Every repo folder this browser holds a handle for, with its current read permission. */
export async function checkFolderAccess(db: FolderDb): Promise<FolderAccess[]> {
  const handles = await db.repoHandles.toArray()
  const repos = await db.repos.bulkGet(handles.map((h) => h.repoId))
  const entries = await Promise.all(
    handles.map(async ({ repoId, dirHandle }, i) => {
      const repo = repos[i]
      return { repoId, label: repo ? repoLabel(repo) : dirHandle.name, handle: dirHandle, state: await queryRead(dirHandle) }
    }),
  )
  return entries.sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Asks again for the folders that lost access, one prompt at a time. Must start in a user gesture;
 * a browser that allows only one prompt per gesture leaves the rest for the next click.
 */
export async function restoreFolderAccess(entries: FolderAccess[]): Promise<FolderAccess[]> {
  const restored: FolderAccess[] = []
  for (const entry of entries) {
    if (entry.state !== 'prompt') {
      restored.push(entry)
      continue
    }
    let state: PermissionState = entry.state
    try {
      state = await entry.handle.requestPermission(READ)
    } catch (error) {
      console.warn(`Could not ask for access to ${entry.label}`, error)
    }
    restored.push({ ...entry, state })
  }
  return restored
}

/** Folders a click can restore; denied ones stay blocked until the site settings change. */
export const restorable = (entries: FolderAccess[]) => entries.filter((entry) => entry.state === 'prompt')

export interface FolderAccessSnapshot {
  checked: boolean
  entries: FolderAccess[]
}

/** The launch-time view of folder permissions, shared by the repos page and Settings. */
export class FolderAccessStore {
  private snapshot: FolderAccessSnapshot = { checked: false, entries: [] }
  private readonly listeners = new Set<() => void>()
  private readonly db: FolderDb
  private generation = 0

  constructor(db: FolderDb) {
    this.db = db
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = () => this.snapshot

  private set(entries: FolderAccess[]) {
    this.snapshot = { checked: true, entries }
    this.listeners.forEach((listener) => listener())
  }

  /** A check that finishes after a later check or restore has started is stale and dropped. */
  async refresh(): Promise<void> {
    const generation = ++this.generation
    const entries = await checkFolderAccess(this.db)
    if (generation === this.generation) this.set(entries)
  }

  /** Re-requests access for the given repos, or every repo that needs it. */
  async restore(repoIds?: string[]): Promise<void> {
    this.generation++
    const targets = this.snapshot.entries.filter((entry) => !repoIds || repoIds.includes(entry.repoId))
    const restored = new Map((await restoreFolderAccess(targets)).map((entry) => [entry.repoId, entry]))
    this.set(this.snapshot.entries.map((entry) => restored.get(entry.repoId) ?? entry))
  }
}
