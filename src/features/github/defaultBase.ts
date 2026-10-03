import { connect } from '../../github/connect'

/**
 * GitHub's default branch, when a token is set and the branch exists locally as origin/<name>.
 * Failures only cost the suggestion, so they are logged rather than thrown.
 */
export async function githubDefaultBase(
  repo: { owner: string | null; name: string | null },
  localBranches: readonly string[],
): Promise<string | null> {
  if (!repo.owner || !repo.name) return null
  try {
    const conn = await connect({ owner: repo.owner, name: repo.name })
    if (!conn) return null
    const { defaultBranch } = await conn.gh.repo(conn.ref)
    return localBranches.includes(defaultBranch) ? defaultBranch : null
  } catch (error) {
    console.warn('Could not read the default branch from GitHub', error)
    return null
  }
}
