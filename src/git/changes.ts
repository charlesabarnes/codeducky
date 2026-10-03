import git, { type WalkerEntry } from 'isomorphic-git'
import type { GitContext } from './context'
import { hashBlob } from './hash'
import { IgnoreRules } from './ignore'
import type { FileChange } from './types'
import { trackedPaths, workdirView } from './workdirFs'

type EntryType = Awaited<ReturnType<WalkerEntry['type']>>

const typeOf = async (entry: WalkerEntry | null): Promise<EntryType | null> => (entry ? entry.type() : null)

async function prepareWalk(ctx: GitContext) {
  const ignoreRules = new IgnoreRules((path) => readText(ctx, path))
  const tracked = trackedPaths(await git.listFiles({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, cache: ctx.cache }))
  const fs = workdirView(ctx.fs, tracked, ignoreRules)
  const indexMtimeSeconds = await indexMtime(ctx)

  const workdirOid = async (work: WalkerEntry, stage: WalkerEntry | null, stageType: EntryType | null) => {
    if (stage && stageType === 'blob') {
      const [workStat, stageStat] = await Promise.all([work.stat(), stage.stat()])
      const cleanByStat =
        workStat.size === stageStat.size &&
        workStat.mtimeSeconds === stageStat.mtimeSeconds &&
        workStat.mtimeSeconds < indexMtimeSeconds
      if (cleanByStat) return stage.oid()
    }
    const content = await work.content()
    return content ? hashBlob(content) : null
  }

  return { fs, workdirOid }
}

const byPath = (a: FileChange, b: FileChange) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** Files that differ between `baseCommit` and the working tree, including untracked, non-ignored files. */
export async function listChanges(ctx: GitContext, baseCommit: string): Promise<FileChange[]> {
  const { dir, gitdir, cache } = ctx
  const { fs, workdirOid } = await prepareWalk(ctx)

  const changes = (await git.walk({
    fs,
    dir,
    gitdir,
    cache,
    trees: [git.TREE({ ref: baseCommit }), git.WORKDIR({ refresh: false }), git.STAGE()],
    map: async (path, [base, work, stage]) => {
      if (path === '.') return undefined
      const [baseType, rawWorkType, stageType] = await Promise.all([
        typeOf(base ?? null),
        typeOf(work ?? null),
        typeOf(stage ?? null),
      ])
      if (baseType === 'commit' || stageType === 'commit') return null
      const workType = rawWorkType === 'special' ? null : rawWorkType

      const baseBlob = baseType === 'blob' ? base : null
      const workBlob = workType === 'blob' ? work : null
      if (baseBlob && !workBlob) {
        return { path, status: 'deleted', oldOid: await baseBlob.oid(), newOid: null } satisfies FileChange
      }
      if (!workBlob) return undefined

      const newOid = await workdirOid(workBlob, stage ?? null, stageType)
      if (!baseBlob) return { path, status: 'added', oldOid: null, newOid } satisfies FileChange
      const oldOid = await baseBlob.oid()
      return oldOid === newOid ? undefined : ({ path, status: 'modified', oldOid, newOid } satisfies FileChange)
    },
  })) as FileChange[]

  return changes.sort(byPath)
}

/**
 * Like `listChanges`, but the base is a path → blob oid map (a tree listed by the GitHub API)
 * rather than a commit, for when the base commit is not in the local object store.
 */
export async function listChangesAgainstOids(ctx: GitContext, base: Record<string, string>): Promise<FileChange[]> {
  const { dir, gitdir, cache } = ctx
  const { fs, workdirOid } = await prepareWalk(ctx)
  const seen = new Set<string>()

  const changes = (await git.walk({
    fs,
    dir,
    gitdir,
    cache,
    trees: [git.WORKDIR({ refresh: false }), git.STAGE()],
    map: async (path, [work, stage]) => {
      if (path === '.') return undefined
      const [rawWorkType, stageType] = await Promise.all([typeOf(work ?? null), typeOf(stage ?? null)])
      if (stageType === 'commit') return null
      if (rawWorkType !== 'blob' || !work) return undefined
      seen.add(path)
      const newOid = await workdirOid(work, stage ?? null, stageType)
      const oldOid = base[path] ?? null
      if (!oldOid) return { path, status: 'added', oldOid: null, newOid } satisfies FileChange
      return oldOid === newOid ? undefined : ({ path, status: 'modified', oldOid, newOid } satisfies FileChange)
    },
  })) as FileChange[]

  for (const [path, oldOid] of Object.entries(base)) {
    if (!seen.has(path)) changes.push({ path, status: 'deleted', oldOid, newOid: null })
  }
  return changes.sort(byPath)
}

async function readText({ fs }: GitContext, path: string): Promise<string | null> {
  try {
    return (await fs.promises.readFile(`/${path}`, 'utf8')) as string
  } catch {
    return null
  }
}

async function indexMtime({ fs }: GitContext): Promise<number> {
  try {
    return Math.floor((await fs.promises.stat('/.git/index')).mtimeMs / 1000)
  } catch {
    return 0
  }
}
