import { db } from '../../db/db'
import { saveOpenedRepo } from '../../db/repos'
import { gitService } from '../../git/client'

export async function openRepoFolder(): Promise<number | null> {
  let handle: FileSystemDirectoryHandle
  try {
    handle = await window.showDirectoryPicker({ id: 'skelbert-repo', mode: 'read' })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    throw error
  }
  const info = await gitService().open(handle)
  return saveOpenedRepo(db, handle, info)
}
