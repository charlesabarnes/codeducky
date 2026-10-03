import type { DiffLine } from '../diff/hunks'
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

/** A unified-diff patch as diff lines with their numbers on both sides (hunks only, no gaps). */
export function patchDiffLines(patch: string): DiffLine[] {
  const lines: DiffLine[] = []
  let left = 0
  let right = 0
  let inHunk = false
  const rows = patch.split('\n')
  if (rows[rows.length - 1] === '') rows.pop()
  for (const raw of rows) {
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
    if (marker === '-') lines.push({ kind: 'del', text, oldNo: left++, newNo: null })
    else if (marker === '+') lines.push({ kind: 'add', text, oldNo: null, newNo: right++ })
    else if (marker === ' ' || raw === '') lines.push({ kind: 'context', text, oldNo: left++, newNo: right++ })
  }
  return lines
}
