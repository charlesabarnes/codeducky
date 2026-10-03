import type { FileSide } from '../git/types'

export interface NumberedLine {
  line: number
  text: string
}

export function splitLines(text: string): string[] {
  if (text === '') return []
  const parts = text.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts.map((part) => (part.endsWith('\r') ? part.slice(0, -1) : part))
}

export function numberLines(text: string): NumberedLine[] {
  return splitLines(text).map((line, index) => ({ line: index + 1, text: line }))
}

export function indexOfLine(lines: readonly NumberedLine[], line: number): number {
  let low = 0
  let high = lines.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const value = lines[mid]!.line
    if (value === line) return mid
    if (value < line) low = mid + 1
    else high = mid - 1
  }
  return -1
}

export function contiguousBefore(lines: readonly NumberedLine[], index: number, count: number): NumberedLine[] {
  const result: NumberedLine[] = []
  for (let i = index - 1; i >= 0 && result.length < count; i--) {
    if (lines[i]!.line !== lines[i + 1]!.line - 1) break
    result.unshift(lines[i]!)
  }
  return result
}

export function contiguousAfter(lines: readonly NumberedLine[], index: number, count: number): NumberedLine[] {
  const result: NumberedLine[] = []
  for (let i = index + 1; i < lines.length && result.length < count; i++) {
    if (lines[i]!.line !== lines[i - 1]!.line + 1) break
    result.push(lines[i]!)
  }
  return result
}

export function sideLines(side: FileSide | null): NumberedLine[] | null {
  return side?.kind === 'text' ? numberLines(side.text) : null
}
