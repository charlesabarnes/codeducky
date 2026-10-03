import type { ThemedToken } from 'shiki/core'
import { textOn, type DiffLine, type DiffSide } from './hunks'
import type { SideTokens } from './useHighlight'
import { layerRanges, type WordDiffer } from './wordDiff'

function tokensFor(line: DiffLine, side: DiffSide, tokens: SideTokens): ThemedToken[] | null {
  const number = side === 'old' ? line.oldNo : line.newNo
  return (number ? tokens[side]?.[number - 1] : undefined) ?? null
}

interface CodeTextProps {
  line: DiffLine
  /** Which version of the line to show; context lines can differ in whitespace. */
  side: DiffSide
  tokens: SideTokens
  words?: WordDiffer
}

export function CodeText({ line, side, tokens, words }: CodeTextProps) {
  const text = textOn(line, side)
  const ranges = words && line.kind !== 'context' ? words(line) : null
  const lineTokens = tokensFor(line, side, tokens)
  const mark = line.kind === 'del' ? 'word-del' : 'word-add'
  return (
    <>
      {!lineTokens && !ranges
        ? text
        : layerRanges(lineTokens, text, ranges).map((piece, index) => (
            <span key={index} style={piece.color ? { color: piece.color } : undefined} className={piece.changed ? mark : undefined}>
              {piece.text}
            </span>
          ))}
      {line.noNewline && <span className="muted" title="No newline at end of file"> ⊘</span>}
    </>
  )
}
