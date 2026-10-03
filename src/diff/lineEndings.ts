export type LineEnding = 'LF' | 'CRLF' | 'mixed'

/** The line-ending style of `text`, or null when it has no line breaks. */
export function lineEnding(text: string): LineEnding | null {
  let crlf = 0
  let lf = 0
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++
    else lf++
  }
  if (crlf === 0 && lf === 0) return null
  if (crlf === 0) return 'LF'
  if (lf === 0) return 'CRLF'
  return 'mixed'
}

export interface LineEndingChange {
  from: LineEnding
  to: LineEnding
  /** True when the texts are otherwise identical. */
  only: boolean
}

/**
 * How the line endings changed between two versions of a file, or null if they did not.
 * The diff viewer hides carriage returns, so without this a CRLF switch reads as every line
 * removed and re-added with the same text.
 */
export function lineEndingChange(oldText: string, newText: string): LineEndingChange | null {
  const from = lineEnding(oldText)
  const to = lineEnding(newText)
  if (!from || !to || from === to) return null
  const strip = (text: string) => text.replace(/\r\n/g, '\n')
  return { from, to, only: strip(oldText) === strip(newText) }
}
