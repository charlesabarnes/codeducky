import { db } from '../../db/db'
import type { Repo, Session } from '../../db/schema'
import { gitService } from '../../git/client'
import { connect } from '../../github/connect'
import { githubMergeBase } from '../../github/freshness'

export async function switchToGitHubBase(session: Session, repo: Repo, remoteTip: string): Promise<void> {
  const conn = await connect(repo)
  if (!conn) throw new Error('Set a GitHub token in Settings first.')
  const { headSha } = await gitService().info()
  const mergeBase = await githubMergeBase(conn.gh, conn.ref, remoteTip, headSha)
  await db.sessions.update(session.id!, {
    headSha,
    baseSha: mergeBase,
    baseSource: 'github',
    githubBase: { branch: repo.baseBranch, tipSha: remoteTip },
  })
}

export async function switchToLocalBase(session: Session, repo: Repo): Promise<void> {
  const git = gitService()
  const [base, info] = await Promise.all([git.resolveBase(repo.baseBranch), git.info()])
  await db.sessions.update(session.id!, {
    headSha: info.headSha,
    baseSha: base.mergeBaseSha,
    baseSource: 'local',
    githubBase: undefined,
  })
}
