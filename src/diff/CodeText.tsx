import type { ThemedToken } from 'shiki/core'
import type { DiffLine } from './hunks'
import type { SideTokens } from './useHighlight'

function tokensFor(line: DiffLine, tokens: SideTokens): ThemedToken[] | undefined {
  if (line.kind === 'add') return line.newNo ? tokens.new?.[line.newNo - 1] : undefined
  return line.oldNo ? tokens.old?.[line.oldNo - 1] : undefined
}

export function CodeText({ line, tokens }: { line: DiffLine; tokens: SideTokens }) {
  const lineTokens = tokensFor(line, tokens)
  return (
    <>
      {lineTokens
        ? lineTokens.map((token, index) => (
            <span key={index} style={{ color: token.color }}>
              {token.content}
            </span>
          ))
        : line.text}
      {line.noNewline && <span className="muted" title="No newline at end of file"> ⊘</span>}
    </>
  )
}
