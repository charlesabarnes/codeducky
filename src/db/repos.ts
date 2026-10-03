import { MAX_INSTRUCTIONS } from '../../shared/instructions'
import { repoIdFor } from '../sync/ids'
import type { SkelbertDb } from './db'
import type { OpenedRepo, Repo } from './schema'

export interface RepoIdentity {
  owner: string | null
  name: string | null
  defaultBase: string | null
}

export async function findRepoByHandle(db: SkelbertDb, handle: FileSystemDirectoryHandle): Promise<Repo | undefined> {
  for (const { repoId, dirHandle } of await db.repoHandles.toArray()) {
    if (await dirHandle.isSameEntry(handle)) return db.repos.get(repoId)
  }
  return undefined
}

/**
 * Records an opened folder. A repo with a GitHub remote is matched by owner/name, so a folder
 * opened on a second device attaches to the repo synced from the first. The handle stays local.
 */
export async function saveOpenedRepo(
  db: SkelbertDb,
  handle: FileSystemDirectoryHandle,
  identity: RepoIdentity,
): Promise<string> {
  // isSameEntry is not a Dexie promise, so the handle lookup stays outside the transaction.
  const byHandle = await findRepoByHandle(db, handle)
  return db.transaction('rw', db.repos, db.repoHandles, async () => {
    const derived = repoIdFor(identity.owner ?? '', identity.name ?? '')
    const existing = (await db.repos.get(derived ?? '')) ?? (byHandle?.id === undefined ? undefined : await db.repos.get(byHandle.id))
    const now = Date.now()
    let id: string
    if (existing?.id !== undefined) {
      id = existing.id
      await db.repos.update(id, {
        owner: identity.owner ?? existing.owner,
        name: identity.name ?? existing.name,
        folderName: handle.name,
        baseBranch: existing.baseBranch || (identity.defaultBase ?? ''),
        lastOpenedAt: now,
      })
    } else {
      const repo: Repo = {
        owner: identity.owner ?? '',
        name: identity.name ?? handle.name,
        folderName: handle.name,
        baseBranch: identity.defaultBase ?? '',
        checklistIds: [],
        lastOpenedAt: now,
      }
      if (derived) repo.id = derived
      id = (await db.repos.add(repo)) as string
    }
    await db.repoHandles.put({ repoId: id, dirHandle: handle })
    return id
  })
}

/** Joins a repo with this device's folder handle, if it has one. */
export async function openedRepo(db: SkelbertDb, repo: Repo | undefined): Promise<OpenedRepo | null> {
  if (repo?.id === undefined) return null
  const local = await db.repoHandles.get(repo.id)
  return local ? { ...repo, id: repo.id, dirHandle: local.dirHandle } : null
}

export const repoLabel = (repo: Pick<Repo, 'owner' | 'name'>) => (repo.owner ? `${repo.owner}/${repo.name}` : repo.name)

/** Saves the repo's review instructions; the legacy field goes so the two cannot disagree. */
export async function saveRepoInstructions(db: SkelbertDb, repoId: string, text: string): Promise<void> {
  await db.repos.update(repoId, { instructions: text.trim().slice(0, MAX_INSTRUCTIONS), claudeInstructions: undefined })
}
