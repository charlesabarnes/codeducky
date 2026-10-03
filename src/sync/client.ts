import { useSyncExternalStore } from 'react'
import { db } from '../db/db'
import { SyncController, type SyncSnapshot } from './controller'

export const syncController = new SyncController(db)

export function useSyncState(): SyncSnapshot {
  return useSyncExternalStore(syncController.subscribe, syncController.getSnapshot)
}
