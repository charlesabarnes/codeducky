/**
 * Content similarity the way git's rename detection estimates it (diffcore-delta.c): split each
 * file into chunks that end at a newline or after 64 bytes, then count the bytes of the source
 * whose chunks also occur in the destination. Score = copied bytes / the larger size.
 */

const CHUNK_MAX = 64

export interface Fingerprint {
  size: number
  /** Chunk → total bytes of that chunk in the file. */
  chunks: Map<string, number>
}

export function fingerprint(bytes: Uint8Array): Fingerprint {
  const chunks = new Map<string, number>()
  let size = 0
  let start = 0
  let hash = 0
  let length = 0
  const flush = (end: number) => {
    if (length === 0) return
    const key = `${hash}:${length}:${bytes[start]}:${bytes[end - 1]}`
    chunks.set(key, (chunks.get(key) ?? 0) + length)
    hash = 0
    length = 0
  }
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!
    // git ignores the CR of a CRLF pair in text, so a line-ending change alone is still a rename.
    if (byte === 13 && bytes[i + 1] === 10) continue
    if (length === 0) start = i
    hash = (Math.imul(hash, 31) + byte) | 0
    length++
    size++
    if (byte === 10 || length === CHUNK_MAX) flush(i + 1)
  }
  flush(bytes.length)
  return { size, chunks }
}

/** 0–1. Sizes that differ by more than the minimum score allows return 0 without comparing chunks. */
export function similarity(a: Fingerprint, b: Fingerprint, minimum = 0): number {
  const larger = Math.max(a.size, b.size)
  if (larger === 0) return 1
  if (Math.min(a.size, b.size) < larger * minimum) return 0
  const [small, big] = a.chunks.size <= b.chunks.size ? [a.chunks, b.chunks] : [b.chunks, a.chunks]
  let copied = 0
  for (const [key, bytes] of small) {
    const other = big.get(key)
    if (other) copied += Math.min(bytes, other)
  }
  return copied / larger
}
