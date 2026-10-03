import { applicableChecklists, checkedItems } from '../../db/checklists'
import { db } from '../../db/db'
import { sessionViews } from '../../db/fileViews'
import { sessionNotes } from '../../db/notes'
import { repoLabel } from '../../db/repos'
import type { Repo, Session } from '../../db/schema'
import { saveTextFile } from '../../fs/pickers'
import type { FileChange } from '../../git/types'
import { buildReport, reportFileName, type ReportInput } from '../../review/report'
import { viewedPaths } from '../../review/viewed'

export async function loadReportInput(session: Session, repo: Repo, files?: FileChange[]): Promise<ReportInput> {
  const sessionId = session.id!
  const [notes, checklists, checked, views] = await Promise.all([
    sessionNotes(db, sessionId),
    applicableChecklists(db, repo.id!),
    checkedItems(db, sessionId),
    sessionViews(db, sessionId),
  ])
  const viewed = files ? viewedPaths(files, views) : null
  return {
    repoName: repoLabel(repo),
    baseBranch: repo.baseBranch,
    session,
    files: files && viewed ? files.map((file) => ({ path: file.path, viewed: viewed.has(file.path) })) : undefined,
    notes,
    checklists: checklists.map((checklist) => ({
      title: checklist.title,
      items: checklist.items.map((item) => ({ text: item.text, checked: checked.has(item.id) })),
    })),
  }
}

export async function exportSessionReport(session: Session, repo: Repo, files?: FileChange[]): Promise<boolean> {
  const input = await loadReportInput(session, repo, files)
  return saveTextFile(reportFileName(input.repoName, session), buildReport(input), 'markdown')
}
