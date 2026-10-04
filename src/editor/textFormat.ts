import { lineEnding } from '../diff/lineEndings'

/** What the editor's plain `\n` text loses and saving must put back. */
export interface TextFormat {
  bom: boolean
  eol: '\n' | '\r\n'
}

const BOM = [0xef, 0xbb, 0xbf]

const hasBom = (bytes: Uint8Array) => BOM.every((byte, index) => bytes[index] === byte)

/** Mixed endings come back as LF: the editor keeps one line separator. */
export function decodeText(bytes: Uint8Array): { text: string; format: TextFormat } {
  const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
  const bom = hasBom(bytes)
  const body = bom ? raw.slice(1) : raw
  const eol = lineEnding(body) === 'CRLF' ? '\r\n' : '\n'
  return { text: eol === '\r\n' ? body.replace(/\r\n/g, '\n') : body, format: { bom, eol } }
}

export function encodeText(text: string, format: TextFormat): Uint8Array {
  const body = new TextEncoder().encode(format.eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text)
  if (!format.bom) return body
  const bytes = new Uint8Array(BOM.length + body.byteLength)
  bytes.set(BOM)
  bytes.set(body, BOM.length)
  return bytes
}
