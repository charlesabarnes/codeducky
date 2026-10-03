import { HandleFs } from '../fs/handleFs'
import git from 'isomorphic-git'
import { analyzeChanges } from './analysis'
import { listChanges, listChangesAgainstOids } from './changes'
import { missingBlobs, readFileContents, readFileStats } from './contents'
import { createContext, type GitContext } from './context'
import { listPackIndexes, warmPacks } from './packs'
import { readNewBytes, readOldBytes } from './contents'
import { detectRenames } from './renames'
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

  const opened = (): GitContext => {
    if (!ctx) throw new Error('No repository is open.')
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
    /** Pairs deleted and added files into renames (base blobs from GitHub must be supplied first). */
    async detectRenames(changes: FileChange[]) {
      const current = opened()
      return detectRenames(changes, {
        readOld: (change) => readOldBytes(current, change.oldOid!),
        readNew: (change) => readNewBytes(current, change.path),
      })
    },
    /** Line counts per file plus moved blocks across the change set. */
    async analyze(changes: FileChange[], maxBytes?: number) {
      return analyzeChanges(opened(), changes, maxBytes)
    },
    /** The blob oid of each path in a commit, or null where the path is not in it. */
    async oidsAt(commit: string, paths: string[]) {
      const { fs, dir, gitdir, cache } = opened()
      const result: Record<string, string | null> = {}
      for (const filepath of paths) {
        try {
          result[filepath] = (await git.readBlob({ fs, dir, gitdir, cache, oid: commit, filepath })).oid
        } catch {
          result[filepath] = null
        }
      }
      return result
    },
  }
}

export type GitService = ReturnType<typeof createGitService>
