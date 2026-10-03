import { HandleFs } from '../fs/handleFs'
import git from 'isomorphic-git'
import { listChanges, listChangesAgainstOids } from './changes'
import { missingBlobs, readFileContents, readFileStats } from './contents'
import { createContext, type GitContext } from './context'
import { listPackIndexes, warmPacks } from './packs'
import { readRepoInfo, resolveBase } from './repo'
import type { FileChange } from './types'

export function createGitService() {
  let ctx: GitContext | null = null
  let packs = ''
  const blobs = new Map<string, Uint8Array>()

  const fresh = async (): Promise<GitContext> => {
    if (!ctx) throw new Error('No repository is open.')
    ctx.fs.clearCache()
    const current = (await listPackIndexes(ctx)).join()
    if (current !== packs) {
      ctx.cache = {}
      packs = current
      await warmPacks(ctx)
    }
    return ctx
  }

  return {
    async open(handle: FileSystemDirectoryHandle) {
      ctx = createContext(new HandleFs(handle), blobs)
      packs = ''
      return readRepoInfo(await fresh())
    },
    async info() {
      return readRepoInfo(await fresh())
    },
    async resolveBase(baseBranch: string) {
      return resolveBase(await fresh(), baseBranch)
    },
    async changes(baseCommit: string) {
      return listChanges(await fresh(), baseCommit)
    },
    async changesAgainstOids(base: Record<string, string>) {
      return listChangesAgainstOids(await fresh(), base)
    },
    async hasCommit(sha: string) {
      const { fs, dir, gitdir, cache } = await fresh()
      try {
        await git.readCommit({ fs, dir, gitdir, cache, oid: sha })
        return true
      } catch {
        return false
      }
    },
    /** HEAD and its first parents, newest first, up to `limit` commits or the first one missing locally. */
    async firstParents(limit: number) {
      const { fs, dir, gitdir, cache } = await fresh()
      const shas: string[] = []
      let oid: string | undefined = await git.resolveRef({ fs, dir, gitdir, ref: 'HEAD' })
      while (oid && shas.length < limit) {
        shas.push(oid)
        try {
          oid = (await git.readCommit({ fs, dir, gitdir, cache, oid })).commit.parent[0]
        } catch {
          break
        }
      }
      return shas
    },
    async missingBlobs(oids: string[]) {
      if (!ctx) throw new Error('No repository is open.')
      return missingBlobs(ctx, oids)
    },
    addBlobs(supplied: Record<string, Uint8Array>) {
      for (const [oid, bytes] of Object.entries(supplied)) blobs.set(oid, bytes)
    },
    async stats(changes: FileChange[], maxBytes?: number) {
      if (!ctx) throw new Error('No repository is open.')
      return readFileStats(ctx, changes, maxBytes)
    },
    async contents(change: FileChange, maxBytes?: number) {
      if (!ctx) throw new Error('No repository is open.')
      return readFileContents(ctx, change, maxBytes)
    },
  }
}

export type GitService = ReturnType<typeof createGitService>
