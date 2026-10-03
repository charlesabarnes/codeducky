import type { FileSide } from './types'

export const DEFAULT_MAX_BYTES = 1024 * 1024
const BINARY_SNIFF_BYTES = 8000

export function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.byteLength, BINARY_SNIFF_BYTES)
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true
  return false
}

export function toSide(bytes: Uint8Array, maxBytes: number): FileSide {
  const size = bytes.byteLength
  if (isBinary(bytes)) return { kind: 'binary', size }
  if (size > maxBytes) return { kind: 'too-large', size }
  return { kind: 'text', text: new TextDecoder().decode(bytes), size }
}
