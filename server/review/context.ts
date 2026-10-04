import { repoInstructions } from '../../shared/instructions'
import { isPrSession, repoLabel, type DataSnapshot, type SessionRecord } from '../mcp/records'
import { checklistView, compareNotes, iso, noteView, prView } from '../mcp/views'
import { recurringPatterns } from './patterns'

/** Everything a reviewer needs before reading the diff of one session. */
export function reviewContext(data: DataSnapshot, session: SessionRecord, origin: string) {
  const repo = data.repoById.get(session.repoId)
  const notes = data.notes()
  const inSession = notes.filter((note) => note.sessionId === session.id).sort(compareNotes)
  const repoSessions = new Set(data.sessions.filter((s) => s.repoId === session.repoId).map((s) => s.id))
  const resolved = notes.filter((note) => note.status === 'resolved' && repoSessions.has(note.sessionId))
  const files = session.files ?? []
  const totals = files.reduce((sum, file) => ({ additions: sum.additions + (file.additions ?? 0), deletions: sum.deletions + (file.deletions ?? 0) }), {
    additions: 0,
    deletions: 0,
  })

  const pr = prView(session, origin)
  return {
    repo: repo ? repoLabel(repo) : session.repoId,
    branch: session.branch,
    baseBranch: (isPrSession(session) ? session.pr?.baseRef : undefined) ?? repo?.baseBranch ?? null,
    session: {
      id: session.id,
      source: session.source ?? 'local',
      status: session.status,
      started: iso(session.startedAt),
      headSha: session.headSha,
      baseSha: session.baseSha,
      url: `${origin}/sessions/${encodeURIComponent(session.id)}`,
    },
    ...(pr ? { pullRequest: pr } : {}),
    ...(isPrSession(session) && session.pr
      ? {
          howToReadDiff:
            `This session reviews pull request #${session.pr.number}; the diff is the PR diff (head ${session.headSha.slice(0, 7)} against merge base ${session.baseSha.slice(0, 7)}). ` +
            `Read it with \`gh pr diff ${session.pr.number} --repo ${session.pr.owner}/${session.pr.name}\` (or a checkout of the PR), and anchor notes on the head version of each file.`,
        }
      : {}),
    instructions: repo ? repoInstructions(repo) : '',
    checklists: checklistView(data, session).checklists,
    files: {
      // Recorded by Rubberduck's last scan, which may be older than the checkout; git diff is the source of truth.
      scanned: session.files !== undefined,
      count: files.length,
      ...totals,
      list: files,
    },
    openNotes: inSession.filter((note) => note.status === 'open').map((note) => noteView(note, data)),
    pendingSuggestions: inSession.filter((note) => note.status === 'suggested').map((note) => noteView(note, data)),
    recurring: recurringPatterns(resolved),
  }
}
