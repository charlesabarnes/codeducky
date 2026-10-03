import { findBranchSession, sessionChecklists, type DataSnapshot, type NoteRecord } from '../mcp/records'
import { headline } from '../review/patterns'

export const BLOCKING_SEVERITIES: ReadonlySet<NoteRecord['severity']> = new Set(['blocker', 'issue'])
const MAX_LISTED = 10

export interface GateResult {
  pass: boolean
  reasons: string[]
  counts: { blockers: number; issues: number; uncheckedRequired: number }
  url: string
  session: string | null
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
    const why = repos.length ? `No Skelbert session for ${repoQuery}@${branch}` : `${repoQuery} is not in Skelbert`
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
  return { pass: reasons.length === 0, reasons: listed, counts, url: `${origin}/sessions/${encodeURIComponent(session.id)}`, session: session.id }
}

/** The plain-text form the hook scripts read without a JSON parser: PASS or FAIL, reasons, then the link. */
export function gateText(result: GateResult): string {
  return [result.pass ? 'PASS' : 'FAIL', ...result.reasons.map((reason) => `- ${reason.replace(/[\r\n]+/g, ' ')}`), `url ${result.url}`].join('\n') + '\n'
}
