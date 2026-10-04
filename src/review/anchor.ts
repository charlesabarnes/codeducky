import type { NoteAnchor, NoteSide } from '../db/schema'
import { contiguousAfter, contiguousBefore, indexOfLine, type NumberedLine } from './lines'

export { isRange, lastLine, lineSpan, linesLabel, MAX_RANGE_LINES } from '../../shared/anchor'

export const CONTEXT_LINES = 3

/** The text of every line the anchor covers. */
export const anchoredText = (anchor: NoteAnchor) => (anchor.rangeText?.length ? anchor.rangeText : [anchor.text])

export function createAnchor(
  lines: readonly NumberedLine[],
  line: number,
  side: NoteSide,
  endLine = line,
  context = CONTEXT_LINES,
): NoteAnchor {
  const index = indexOfLine(lines, line)
  if (index < 0) throw new Error(`Line ${line} is not available on the ${side} side.`)
  const endIndex = index + endLine - line
  if (endLine < line || lines[endIndex]?.line !== endLine) throw new Error(`Lines ${line}–${endLine} are not all available on the ${side} side.`)
  const anchor: NoteAnchor = {
    line,
    side,
    text: lines[index]!.text,
    before: contiguousBefore(lines, index, context).map((entry) => entry.text),
    after: contiguousAfter(lines, endIndex, context).map((entry) => entry.text),
  }
  if (endLine === line) return anchor
  return { ...anchor, endLine, rangeText: lines.slice(index, endIndex + 1).map((entry) => entry.text) }
}
