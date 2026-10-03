import { describe, expect, it } from 'vitest'
import { buildLines, textOn } from '../../src/diff/hunks'

const kinds = (lines: ReturnType<typeof buildLines>) => lines.map((line) => line.kind[0]).join('')

describe('buildLines with ignoreWhitespace', () => {
  const oldText = 'function f() {\n  return 1\n}\n'
  const newText = 'function f() {\n    return 1\n}\n'

  it('shows indentation changes by default', () => {
    expect(kinds(buildLines(oldText, newText))).toBe('cdac')
  })

  it('treats whitespace-only changes as context and keeps both texts', () => {
    const lines = buildLines(oldText, newText, { ignoreWhitespace: true })
    expect(kinds(lines)).toBe('ccc')
    const body = lines[1]!
    expect(body).toMatchObject({ oldNo: 2, newNo: 2, text: '    return 1', oldText: '  return 1' })
    expect(textOn(body, 'old')).toBe('  return 1')
    expect(textOn(body, 'new')).toBe('    return 1')
    expect(lines[0]!.oldText).toBeUndefined()
  })

  it('keeps line numbers on both sides right around real changes', () => {
    const lines = buildLines('a\n  b\nc\nd\n', 'a\nb\nC\nd\ne\n', { ignoreWhitespace: true })
    expect(lines.map((line) => [line.kind, line.oldNo, line.newNo])).toEqual([
      ['context', 1, 1],
      ['context', 2, 2],
      ['del', 3, null],
      ['add', null, 3],
      ['context', 4, 4],
      ['add', null, 5],
    ])
  })

  it('ignores whitespace inside a line and CRLF endings', () => {
    expect(kinds(buildLines('a = b + c\r\n', 'a=b+c\n', { ignoreWhitespace: true }))).toBe('c')
  })

  it('still shows added blank lines', () => {
    expect(kinds(buildLines('a\nb\n', 'a\n\nb\n', { ignoreWhitespace: true }))).toBe('cac')
  })
})
