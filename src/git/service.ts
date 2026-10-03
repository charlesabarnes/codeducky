import { HandleFs } from '../fs/handleFs'
import { listChanges } from './changes'
import { readFileContents, readFileStats } from './contents'
import { createContext, type GitContext } from './context'
import { listPackIndexes, warmPacks } from './packs'
import { readRepoInfo, resolveBase } from './repo'
import type { FileChange } from './types'

export function createGitService() {
  let ctx: GitContext | null = null
  let packs = ''

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
      ctx = createContext(new HandleFs(handle))
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
