import { db } from '../../db/db'
import { saveOpenedRepo } from '../../db/repos'
import type { Repo } from '../../db/schema'
import { gitService } from '../../git/client'
import { githubDefaultBase } from '../github/defaultBase'

async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await window.showDirectoryPicker({ id: 'skelbert-repo', mode: 'read' })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    throw error
  }
}

export async function openRepoFolder(): Promise<string | null> {
  const handle = await pickFolder()
  if (!handle) return null
  const info = await gitService().open(handle)
  const defaultBase = (await githubDefaultBase(info, info.baseBranches)) ?? info.defaultBase
  return saveOpenedRepo(db, handle, { ...info, defaultBase })
}

/** Attaches a local checkout to a repo synced from another device; the folder must have the same GitHub remote. */
export async function locateRepoFolder(repo: Repo): Promise<boolean> {
  const handle = await pickFolder()
  if (!handle) return false
  const info = await gitService().open(handle)
  const sameRemote =
    repo.owner && info.owner && repo.owner.toLowerCase() === info.owner.toLowerCase() && repo.name.toLowerCase() === info.name?.toLowerCase()
  if (repo.owner && !sameRemote) {
    throw new Error(`That folder's origin is ${info.owner ? `${info.owner}/${info.name}` : 'not on GitHub'}, not ${repo.owner}/${repo.name}.`)
  }
  await saveOpenedRepo(db, handle, { owner: info.owner, name: info.name, defaultBase: null })
  return true
}
