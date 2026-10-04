/** Line spans of note anchors, shared by the PWA and the server. */

export interface LineSpan {
  /** The line, or the first line of a range. */
  line: number
  /** The last line of a range; absent on a single line. */
  endLine?: number | null
}

export const lastLine = (span: LineSpan) => span.endLine ?? span.line

export const isRange = (span: LineSpan) => lastLine(span) > span.line

/** "12", or "12–18" for a range, as in path:12–18. */
export const lineSpan = (span: LineSpan) => (isRange(span) ? `${span.line}–${lastLine(span)}` : String(span.line))

/** "line 12", or "lines 12–18" for a range. */
export const linesLabel = (span: LineSpan) => `${isRange(span) ? 'lines' : 'line'} ${lineSpan(span)}`
