import { describe, expect, it } from 'vitest'
import { decodeText, encodeText } from '../../src/editor/textFormat'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('decodeText and encodeText', () => {
  it('round-trips LF files unchanged', () => {
    const decoded = decodeText(bytes('a\nb\n'))
    expect(decoded).toEqual({ text: 'a\nb\n', format: { bom: false, eol: '\n' } })
    expect(encodeText(decoded.text, decoded.format)).toEqual(bytes('a\nb\n'))
  })

  it('edits CRLF files as LF and writes them back as CRLF', () => {
    const decoded = decodeText(bytes('a\r\nb\r\n'))
    expect(decoded.text).toBe('a\nb\n')
    expect(new TextDecoder().decode(encodeText('a\nb\nc', decoded.format))).toBe('a\r\nb\r\nc')
  })

  it('keeps a byte order mark', () => {
    const decoded = decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('x\n')]))
    expect(decoded).toEqual({ text: 'x\n', format: { bom: true, eol: '\n' } })
    expect([...encodeText('y\n', decoded.format)]).toEqual([0xef, 0xbb, 0xbf, ...bytes('y\n')])
  })

  it('treats mixed line endings as LF', () => {
    expect(decodeText(bytes('a\r\nb\n')).format.eol).toBe('\n')
  })
})
