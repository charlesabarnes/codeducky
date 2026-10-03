import type { SkelbertDb } from './db'
import type { Repo } from './schema'

export interface RepoIdentity {
  owner: string | null
  name: string | null
  defaultBase: string | null
}

export async function findRepoByHandle(db: SkelbertDb, handle: FileSystemDirectoryHandle): Promise<Repo | undefined> {
  for (const repo of await db.repos.toArray()) {
    if (await repo.dirHandle.isSameEntry(handle)) return repo
  }
  return undefined
}

export async function saveOpenedRepo(
  db: SkelbertDb,
  handle: FileSystemDirectoryHandle,
  identity: RepoIdentity,
): Promise<number> {
  const existing = await findRepoByHandle(db, handle)
  const now = Date.now()
  if (existing?.id !== undefined) {
    await db.repos.update(existing.id, {
      dirHandle: handle,
      owner: identity.owner ?? existing.owner,
      name: identity.name ?? existing.name,
      lastOpenedAt: now,
    })
    return existing.id
  }
  return db.repos.add({
    dirHandle: handle,
    owner: identity.owner ?? '',
    name: identity.name ?? handle.name,
    folderName: handle.name,
    baseBranch: identity.defaultBase ?? '',
    checklistIds: [],
    lastOpenedAt: now,
  }) as Promise<number>
}
