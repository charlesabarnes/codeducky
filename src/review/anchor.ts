import type { NoteAnchor, NoteSide } from '../db/schema'
import { contiguousAfter, contiguousBefore, indexOfLine, type NumberedLine } from './lines'

export const CONTEXT_LINES = 3

export function createAnchor(
  lines: readonly NumberedLine[],
  line: number,
  side: NoteSide,
  context = CONTEXT_LINES,
): NoteAnchor {
  const index = indexOfLine(lines, line)
  if (index < 0) throw new Error(`Line ${line} is not available on the ${side} side.`)
  return {
    line,
    side,
    text: lines[index]!.text,
    before: contiguousBefore(lines, index, context).map((entry) => entry.text),
    after: contiguousAfter(lines, index, context).map((entry) => entry.text),
  }
}
