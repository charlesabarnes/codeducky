import { prUrl } from '../../shared/links'
import { findBranchSession, isPrSession, sessionChecklists, type DataSnapshot, type NoteRecord, type SessionRecord } from '../mcp/records'
import { headline } from '../review/patterns'

export const BLOCKING_SEVERITIES: ReadonlySet<NoteRecord['severity']> = new Set(['blocker', 'issue'])
const MAX_LISTED = 10

export interface GateResult {
  pass: boolean
  reasons: string[]
  counts: { blockers: number; issues: number; uncheckedRequired: number }
  url: string
  session: string | null
  /** The branch's pull request in Code Ducky, when one is known. */
  prUrl?: string
}

/** The branch's pull request: on its session, or on a PR session for the same branch. */
function branchPr(data: DataSnapshot, session: SessionRecord): SessionRecord['pr'] {
  if (session.pr) return session.pr
  return data.sessions.find((s) => isPrSession(s) && s.repoId === session.repoId && s.branch === session.branch && s.pr)?.pr
}

const noteLine = (note: NoteRecord) => {
  const title = headline(note)
  return `${note.severity}: ${note.path}:${note.anchor.line}${title ? ` ${title}` : ''}`
}

/**
 * Whether a push of this repo and branch may go ahead: it may not while the branch's current
 * session has open blocker or issue notes, or unticked items on a required checklist.
 * Without a session there is nothing to check, so the push passes.
 */
export function evaluateGate(data: DataSnapshot, repoQuery: string, branch: string, origin: string): GateResult {
  const { repos, session } = findBranchSession(data, repoQuery, branch)
  const counts = { blockers: 0, issues: 0, uncheckedRequired: 0 }
  if (!session) {
    const why = repos.length ? `No Code Ducky session for ${repoQuery}@${branch}` : `${repoQuery} is not in Code Ducky`
    return { pass: true, reasons: [`${why}; nothing to check.`], counts, url: origin, session: null }
  }

  const blocking = data
    .notes()
    .filter((note) => note.sessionId === session.id && note.status === 'open' && BLOCKING_SEVERITIES.has(note.severity))
    .sort((a, b) => (a.severity === b.severity ? a.path.localeCompare(b.path) || a.anchor.line - b.anchor.line : a.severity === 'blocker' ? -1 : 1))
  counts.blockers = blocking.filter((note) => note.severity === 'blocker').length
  counts.issues = blocking.length - counts.blockers

  const unchecked = sessionChecklists(data.checklists(), session)
    .filter((list) => list.required)
    .flatMap((list) => list.items.filter((item) => !data.checked(session.id, item.id)).map((item) => `Unticked on required checklist "${list.title}": ${item.text}`))
  counts.uncheckedRequired = unchecked.length

  const reasons = [...blocking.map(noteLine), ...unchecked]
  const listed = reasons.slice(0, MAX_LISTED)
  if (reasons.length > MAX_LISTED) listed.push(`…and ${reasons.length - MAX_LISTED} more`)
  const pr = branchPr(data, session)
  return {
    pass: reasons.length === 0,
    reasons: listed,
    counts,
    url: `${origin}/sessions/${encodeURIComponent(session.id)}`,
    session: session.id,
    ...(pr ? { prUrl: prUrl(origin, pr) } : {}),
  }
}

/** The plain-text form the hook scripts read without a JSON parser: PASS or FAIL, reasons, the link, then the PR link if any. */
export function gateText(result: GateResult): string {
  const lines = [result.pass ? 'PASS' : 'FAIL', ...result.reasons.map((reason) => `- ${reason.replace(/[\r\n]+/g, ' ')}`), `url ${result.url}`]
  if (result.prUrl) lines.push(`pr ${result.prUrl}`)
  return lines.join('\n') + '\n'
}
