import type { Note, NoteAnchor, NoteSeverity, NoteSide } from '../db/schema'
import { createAnchor } from '../review/anchor'
import { indexOfLine, type NumberedLine } from '../review/lines'
import { matchAnchor } from '../review/match'
import type { Finding } from './types'

export type SideLines = Record<NoteSide, readonly NumberedLine[] | null>

export interface SuggestionDraft {
  path: string
  anchor: NoteAnchor
  severity: NoteSeverity
  title: string
  body: string
}

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ')

/**
 * Anchors a finding on the file's current lines. The reported line wins when its text agrees;
 * otherwise the nearest line with that text; otherwise the reported line if it exists at all.
 */
export function anchorFinding(finding: Finding, lines: SideLines): NoteAnchor | null {
  const sideLines = lines[finding.side]
  if (!sideLines || sideLines.length === 0) return null
  const index = indexOfLine(sideLines, finding.line)
  const reported = index >= 0 ? sideLines[index]! : null
  if (reported && normalize(reported.text) === normalize(finding.lineText)) {
    return createAnchor(sideLines, reported.line, finding.side)
  }
  if (normalize(finding.lineText) !== '') {
    const probe: NoteAnchor = { line: finding.line, side: finding.side, text: finding.lineText, before: [], after: [] }
    const match = matchAnchor(probe, sideLines)
    if (match) return createAnchor(sideLines, match.line, finding.side)
  }
  return reported ? createAnchor(sideLines, reported.line, finding.side) : null
}

export const suggestionBody = (title: string, body: string) => (body ? `**${title}**\n\n${body}` : `**${title}**`)

export function toSuggestions(findings: readonly Finding[], lines: SideLines): { drafts: SuggestionDraft[]; unanchored: number } {
  const drafts: SuggestionDraft[] = []
  let unanchored = 0
  for (const finding of findings) {
    const anchor = anchorFinding(finding, lines)
    if (!anchor) {
      unanchored++
      continue
    }
    drafts.push({
      path: finding.path,
      anchor,
      severity: finding.severity,
      title: finding.title,
      body: suggestionBody(finding.title, finding.body),
    })
  }
  return { drafts, unanchored }
}

type Keyed = Pick<Note, 'path' | 'anchor'> & { title?: string }

/** Two findings are duplicates when they sit on the same anchored line and share a title. */
export const suggestionKey = ({ path, anchor, title }: Keyed) =>
  [path, anchor.side, anchor.line, normalize(anchor.text), normalize(title ?? '').toLowerCase()].join('\u0000')
