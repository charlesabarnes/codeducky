import { useSyncExternalStore } from 'react'
import { db } from '../db/db'
import { FolderAccessStore, type FolderAccessSnapshot } from './folderAccess'

export const folderAccess = new FolderAccessStore(db)

export function useFolderAccess(): FolderAccessSnapshot {
  return useSyncExternalStore(folderAccess.subscribe, folderAccess.getSnapshot)
}
