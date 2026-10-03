import { describe, expect, it } from 'vitest'
import { lineEnding, lineEndingChange } from '../../src/diff/lineEndings'

describe('lineEnding', () => {
  it.each([
    ['', null],
    ['one line', null],
    ['a\nb\n', 'LF'],
    ['a\r\nb\r\n', 'CRLF'],
    ['\r\n', 'CRLF'],
    ['a\r\nb\n', 'mixed'],
    ['\n', 'LF'],
  ] as const)('%j is %s', (text, expected) => {
    expect(lineEnding(text)).toBe(expected)
  })
})

describe('lineEndingChange', () => {
  it('reports a switch that changes nothing else', () => {
    expect(lineEndingChange('a\nb\n', 'a\r\nb\r\n')).toEqual({ from: 'LF', to: 'CRLF', only: true })
    expect(lineEndingChange('a\r\nb\r\n', 'a\nb\n')).toEqual({ from: 'CRLF', to: 'LF', only: true })
  })

  it('reports a switch alongside other edits', () => {
    expect(lineEndingChange('a\nb\n', 'a\r\nc\r\n')).toEqual({ from: 'LF', to: 'CRLF', only: false })
  })

  it('is null when the style is unchanged or a side has no line breaks', () => {
    expect(lineEndingChange('a\nb\n', 'a\nc\n')).toBeNull()
    expect(lineEndingChange('a\r\nb\r\n', 'a\r\nc\r\n')).toBeNull()
    expect(lineEndingChange('', 'a\r\n')).toBeNull()
  })
})
