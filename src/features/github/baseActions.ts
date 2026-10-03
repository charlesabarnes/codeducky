import { db } from '../../db/db'
import type { Repo, Session } from '../../db/schema'
import { gitService } from '../../git/client'
import { connect } from '../../github/connect'
import { findGitHubBase, type GitHubBase } from '../../github/pushedBase'

/** The merge base of HEAD (or its last pushed ancestor) and `baseBranch` on GitHub. */
export async function resolveGitHubBase(repo: Pick<Repo, 'owner' | 'name'>, baseBranch: string, remoteTip?: string): Promise<GitHubBase> {
  const conn = await connect(repo)
  if (!conn) throw new Error('Set a GitHub token in Settings first.')
  return findGitHubBase(conn.gh, conn.ref, gitService(), { baseBranch, remoteTip })
}

export async function switchToGitHubBase(session: Session, repo: Repo, remoteTip: string): Promise<void> {
  const base = await resolveGitHubBase(repo, repo.baseBranch, remoteTip)
  await db.sessions.update(session.id!, { ...base, baseSource: 'github', baseNotice: undefined })
}

export async function switchToLocalBase(session: Session, repo: Repo): Promise<void> {
  const git = gitService()
  const [base, info] = await Promise.all([git.resolveBase(repo.baseBranch), git.info()])
  await db.sessions.update(session.id!, {
    headSha: info.headSha,
    baseSha: base.mergeBaseSha,
    baseSource: 'local',
    githubBase: undefined,
    baseNotice: undefined,
  })
}
