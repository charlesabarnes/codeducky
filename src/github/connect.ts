import { db } from '../db/db'
import type { Repo } from '../db/schema'
import { loadSettings } from '../db/settings'
import { createGitHubClient, type GitHubClient } from './client'
import type { RepoRef } from './types'

export async function githubClient(): Promise<GitHubClient | null> {
  const { githubPat } = await loadSettings(db)
  return githubPat ? createGitHubClient({ token: githubPat }) : null
}

export const repoRef = (repo: Pick<Repo, 'owner' | 'name'>): RepoRef | null =>
  repo.owner && repo.name ? { owner: repo.owner, name: repo.name } : null

export interface Connection {
  gh: GitHubClient
  ref: RepoRef
}

/** A client and repo reference, or null when there is no token or the repo has no GitHub remote. */
export async function connect(repo: Pick<Repo, 'owner' | 'name'>): Promise<Connection | null> {
  const ref = repoRef(repo)
  if (!ref) return null
  const gh = await githubClient()
  return gh ? { gh, ref } : null
}
