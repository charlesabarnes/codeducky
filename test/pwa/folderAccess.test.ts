import { describe, expect, it, vi } from 'vitest'
import type { CodeDuckyDb } from '../../src/db/db'
import type { Repo, RepoHandle } from '../../src/db/schema'
import { checkFolderAccess, FolderAccessStore, restorable, restoreFolderAccess } from '../../src/pwa/folderAccess'
import { memoryRoot } from '../support/memoryHandle'

const repo = (id: string, owner: string, name: string): Repo & { id: string } => ({
  id,
  owner,
  name,
  folderName: name,
  baseBranch: 'main',
  checklistIds: [],
  lastOpenedAt: 0,
})

function fakeDb(rows: { repo?: Repo & { id: string }; repoId: string; handle: FileSystemDirectoryHandle }[]) {
  const handles: RepoHandle[] = rows.map(({ repoId, handle }) => ({ repoId, dirHandle: handle }))
  const repos = new Map(rows.flatMap(({ repo }) => (repo ? [[repo.id, repo] as const] : [])))
  return {
    repoHandles: { toArray: async () => handles },
    repos: { bulkGet: async (ids: string[]) => ids.map((id) => repos.get(id)) },
  } as unknown as Pick<CodeDuckyDb, 'repos' | 'repoHandles'>
}

describe('folder access', () => {
  it('reports each stored handle with its read permission, sorted by repo', async () => {
    const granted = memoryRoot({}).handle
    const lapsed = memoryRoot({}, { permissions: { read: 'prompt' } }).handle
    const blocked = memoryRoot({}, { permissions: { read: 'denied' } }).handle
    const db = fakeDb([
      { repoId: 'gh:acme/web', repo: repo('gh:acme/web', 'acme', 'web'), handle: lapsed },
      { repoId: 'gh:acme/api', repo: repo('gh:acme/api', 'acme', 'api'), handle: granted },
      { repoId: 'local:x', handle: blocked },
    ])
    const entries = await checkFolderAccess(db)
    expect(entries.map((e) => [e.label, e.state])).toEqual([
      ['acme/api', 'granted'],
      ['acme/web', 'prompt'],
      ['root', 'denied'],
    ])
    expect(restorable(entries).map((e) => e.repoId)).toEqual(['gh:acme/web'])
  })

  it('asks again only for folders that need it and keeps going after a failed prompt', async () => {
    const ok = memoryRoot({}, { permissions: { read: 'prompt' } })
    const refused = memoryRoot({}, { permissions: { read: 'prompt' }, answer: 'denied' })
    const already = memoryRoot({})
    const throwing = memoryRoot({}, { permissions: { read: 'prompt' } })
    vi.spyOn(throwing.handle, 'requestPermission').mockRejectedValue(new DOMException('no gesture', 'SecurityError'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const entries = [
      { repoId: 'a', label: 'a', handle: throwing.handle, state: 'prompt' as const },
      { repoId: 'b', label: 'b', handle: ok.handle, state: 'prompt' as const },
      { repoId: 'c', label: 'c', handle: refused.handle, state: 'prompt' as const },
      { repoId: 'd', label: 'd', handle: already.handle, state: 'granted' as const },
    ]
    const restored = await restoreFolderAccess(entries)
    expect(restored.map((e) => e.state)).toEqual(['prompt', 'granted', 'denied', 'granted'])
    expect(already.requests).toEqual([])
    expect(ok.requests).toEqual(['read'])
    warn.mockRestore()
  })

  it('restores one repo or all of them through the store', async () => {
    const first = memoryRoot({}, { permissions: { read: 'prompt' } })
    const second = memoryRoot({}, { permissions: { read: 'prompt' } })
    const store = new FolderAccessStore(
      fakeDb([
        { repoId: 'gh:a/one', repo: repo('gh:a/one', 'a', 'one'), handle: first.handle },
        { repoId: 'gh:a/two', repo: repo('gh:a/two', 'a', 'two'), handle: second.handle },
      ]),
    )
    const seen: number[] = []
    store.subscribe(() => seen.push(restorable(store.getSnapshot().entries).length))
    expect(store.getSnapshot().checked).toBe(false)
    await store.refresh()
    expect(store.getSnapshot().checked).toBe(true)
    await store.restore(['gh:a/two'])
    expect(first.requests).toEqual([])
    expect(second.requests).toEqual(['read'])
    await store.restore()
    expect(first.requests).toEqual(['read'])
    expect(seen).toEqual([2, 1, 0])
  })
})
