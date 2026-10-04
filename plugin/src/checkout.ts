import { hostname as osHostname } from 'node:os'
import { basename } from 'node:path'
import { output } from './config'

export interface Checkout {
  cwd: string
  repo: string | null
  branch: string | null
  hostname: string
  label: string
}

/** owner/name from git@host:owner/name.git, https://host/owner/name(.git) or ssh://git@host/owner/name. */
export function repoFromRemote(remote: string | null): string | null {
  if (!remote) return null
  const match = /[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return match ? `${match[1]}/${match[2]}` : null
}

export type Git = (args: string[]) => string | null

export const systemGit =
  (cwd: string): Git =>
  (args) =>
    output('git', ['-C', cwd, ...args])

export function currentBranch(git: Git): string | null {
  return git(['branch', '--show-current'])
}

export function readCheckout(cwd: string, git: Git, env: Record<string, string | undefined> = process.env, host = osHostname()): Checkout {
  const top = git(['rev-parse', '--show-toplevel']) ?? cwd
  const repo = repoFromRemote(git(['remote', 'get-url', 'origin']))
  const branch = currentBranch(git)
  const shortHost = host.replace(/\.local$/, '')
  const label = env.CODEDUCKY_CHANNEL_LABEL?.trim() || `${basename(top)} on ${shortHost}`
  return { cwd: top, repo, branch, hostname: shortHost, label: label.slice(0, 100) }
}
