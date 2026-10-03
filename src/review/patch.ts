import type { NumberedLine } from './lines'

export type PatchSide = 'LEFT' | 'RIGHT'

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function patchSideLines(patch: string, side: PatchSide): NumberedLine[] {
  const lines: NumberedLine[] = []
  let left = 0
  let right = 0
  let inHunk = false
  for (const raw of patch.split('\n')) {
    const header = HUNK_HEADER.exec(raw)
    if (header) {
      left = Number(header[1])
      right = Number(header[2])
      inHunk = true
      continue
    }
    if (!inHunk || raw.startsWith('\\')) continue
    const marker = raw.charAt(0)
    const text = raw.slice(1)
    if (marker === ' ' || raw === '') {
      lines.push({ line: side === 'LEFT' ? left : right, text })
      left++
      right++
    } else if (marker === '-') {
      if (side === 'LEFT') lines.push({ line: left, text })
      left++
    } else if (marker === '+') {
      if (side === 'RIGHT') lines.push({ line: right, text })
      right++
    }
  }
  return lines
}
