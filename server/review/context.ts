import { repoInstructions } from '../../shared/instructions'
import { repoLabel, type DataSnapshot, type SessionRecord } from '../mcp/records'
import { checklistView, compareNotes, iso, noteView } from '../mcp/views'
import { recurringPatterns } from './patterns'

/** Everything a reviewer needs before reading the diff of one session. */
export function reviewContext(data: DataSnapshot, session: SessionRecord) {
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

  return {
    repo: repo ? repoLabel(repo) : session.repoId,
    branch: session.branch,
    baseBranch: repo?.baseBranch ?? null,
    session: { id: session.id, status: session.status, started: iso(session.startedAt), headSha: session.headSha, baseSha: session.baseSha },
    instructions: repo ? repoInstructions(repo) : '',
    checklists: checklistView(data, session).checklists,
    files: {
      // Recorded by Skelbert's last scan, which may be older than the checkout; git diff is the source of truth.
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
