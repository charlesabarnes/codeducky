import { isRange, lastLine, lineSpan } from '../../shared/anchor'
import { githubPrUrl, prUrl } from '../../shared/links'
import { repoLabel, sessionChecklists, type DataSnapshot, type NoteRecord, type SessionRecord } from './records'

/** How notes and checklists look in tool results. Pure functions of one user's snapshot, with no database access. */

export const iso = (ms: number) => new Date(ms).toISOString()

export function noteView(note: NoteRecord, data: DataSnapshot) {
  const session = data.sessions.find((s) => s.id === note.sessionId)
  const repo = session ? data.repoById.get(session.repoId) : undefined
  return {
    id: note.id,
    repo: repo ? repoLabel(repo) : null,
    branch: session?.branch ?? null,
    session: note.sessionId,
    path: note.path,
    line: note.anchor.line,
    ...(isRange(note.anchor) ? { endLine: lastLine(note.anchor), lines: lineSpan(note.anchor) } : {}),
    side: note.anchor.side,
    severity: note.severity,
    status: note.status,
    source: note.source,
    ...(note.title ? { title: note.title } : {}),
    body: note.body,
    anchor: {
      text: note.anchor.text,
      ...(note.anchor.rangeText?.length ? { rangeText: note.anchor.rangeText } : {}),
      before: note.anchor.before,
      after: note.anchor.after,
    },
    anchorLost: Boolean(note.anchorLost),
    ...(note.resolution ? { resolution: { ...note.resolution, at: iso(note.resolution.at) } } : {}),
  }
}

export const compareNotes = (a: NoteRecord, b: NoteRecord) =>
  a.path.localeCompare(b.path) || a.anchor.line - b.anchor.line || a.createdAt - b.createdAt

export function checklistView(data: DataSnapshot, session: SessionRecord) {
  const repo = data.repoById.get(session.repoId)
  return {
    session: session.id,
    repo: repo ? repoLabel(repo) : session.repoId,
    branch: session.branch,
    checklists: sessionChecklists(data.checklists(), session).map((list) => {
      const items = list.items.map((item) => ({ id: item.id, text: item.text, checked: data.checked(session.id, item.id) }))
      return {
        id: list.id,
        title: list.title,
        scope: list.scope === 'global' ? 'global' : 'repo',
        required: Boolean(list.required),
        done: `${items.filter((item) => item.checked).length}/${items.length}`,
        items,
      }
    }),
  }
}

/** A session's pull request, with links to open it in Code Ducky and on GitHub. */
export function prView(session: SessionRecord, origin: string) {
  const pr = session.pr
  if (!pr) return undefined
  const ref = { owner: pr.owner, name: pr.name, number: pr.number }
  return {
    number: pr.number,
    repo: `${pr.owner}/${pr.name}`,
    ...(pr.title ? { title: pr.title } : {}),
    ...(pr.author ? { author: pr.author } : {}),
    ...(pr.baseRef ? { baseRef: pr.baseRef } : {}),
    headRef: session.branch,
    url: pr.url ?? githubPrUrl(ref),
    codeDuckyUrl: prUrl(origin, ref),
    ...(session.review ? { review: { state: session.review.state, at: iso(session.review.at), ...(session.review.url ? { url: session.review.url } : {}) } } : {}),
  }
}
