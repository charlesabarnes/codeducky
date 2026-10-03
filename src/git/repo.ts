import git from 'isomorphic-git'
import { isFsError } from '../fs/errors'
import type { GitContext } from './context'
import { parseGitHubRemote } from './remote'
import type { BaseResolution, RepoInfo } from './types'

const PREFERRED_BASES = ['main', 'master']

export async function assertRepository({ fs }: GitContext): Promise<void> {
  let stats
  try {
    stats = await fs.promises.stat('/.git')
  } catch (error) {
    if (isFsError(error, 'ENOENT')) throw new Error('This folder is not a git repository (no .git directory).', { cause: error })
    throw error
  }
  if (!stats.isDirectory()) {
    throw new Error('.git is a file (worktree or submodule). Open the main checkout folder instead.')
  }
}

export async function readRepoInfo(ctx: GitContext): Promise<RepoInfo> {
  await assertRepository(ctx)
  const { fs, dir, gitdir } = ctx
  const [remoteUrl, branch, headSha, baseBranches] = await Promise.all([
    git.getConfig({ fs, dir, gitdir, path: 'remote.origin.url' }) as Promise<string | undefined>,
    git.currentBranch({ fs, dir, gitdir, fullname: false }),
    git.resolveRef({ fs, dir, gitdir, ref: 'HEAD' }),
    listBaseBranches(ctx),
  ])
  const remote = remoteUrl ? parseGitHubRemote(remoteUrl) : null
  return {
    owner: remote?.owner ?? null,
    name: remote?.name ?? null,
    remoteUrl: remoteUrl ?? null,
    branch: branch ?? null,
    headSha,
    baseBranches,
    defaultBase: await defaultBaseBranch(ctx, baseBranches),
  }
}

export async function listBaseBranches({ fs, dir, gitdir }: GitContext): Promise<string[]> {
  const branches = await git.listBranches({ fs, dir, gitdir, remote: 'origin' })
  return branches.filter((branch) => branch !== 'HEAD').sort()
}

async function defaultBaseBranch(ctx: GitContext, branches: string[]): Promise<string | null> {
  const originHead = await originHeadBranch(ctx)
  if (originHead && branches.includes(originHead)) return originHead
  return PREFERRED_BASES.find((name) => branches.includes(name)) ?? branches[0] ?? null
}

async function originHeadBranch({ fs, dir, gitdir }: GitContext): Promise<string | null> {
  try {
    const target = await git.expandRef({ fs, dir, gitdir, ref: 'refs/remotes/origin/HEAD' })
    const symbolic = await git.resolveRef({ fs, dir, gitdir, ref: target, depth: 2 })
    return symbolic.startsWith('refs/remotes/origin/') ? symbolic.slice('refs/remotes/origin/'.length) : null
  } catch {
    return null
  }
}

export async function resolveBase(ctx: GitContext, baseBranch: string): Promise<BaseResolution> {
  const { fs, dir, gitdir, cache } = ctx
  const [headSha, baseTipSha] = await Promise.all([
    git.resolveRef({ fs, dir, gitdir, ref: 'HEAD' }),
    git.resolveRef({ fs, dir, gitdir, ref: `refs/remotes/origin/${baseBranch}` }),
  ])
  const bases = (await git.findMergeBase({ fs, dir, gitdir, cache, oids: [headSha, baseTipSha] })) as string[]
  const mergeBaseSha = bases[0]
  if (!mergeBaseSha) throw new Error(`HEAD and origin/${baseBranch} have no common ancestor.`)
  return { baseBranch, baseTipSha, mergeBaseSha }
}
