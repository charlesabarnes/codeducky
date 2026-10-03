let lastMs = -1
let lastRand = new Uint8Array(10)

function increment(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i--) {
    bytes[i] = (bytes[i]! + 1) & 0xff
    if (bytes[i] !== 0) return
  }
}

/** RFC 9562 UUIDv7, monotonic within one millisecond, so ids sort by creation time. */
export function uuidv7(now: number = Date.now()): string {
  const ms = Math.max(now, lastMs)
  if (ms === lastMs) {
    increment(lastRand)
  } else {
    lastRand = crypto.getRandomValues(new Uint8Array(10))
    lastRand[0]! &= 0x0f
  }
  lastMs = ms

  const bytes = new Uint8Array(16)
  let t = ms
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256
    t = Math.floor(t / 256)
  }
  bytes.set(lastRand, 6)
  bytes[6] = 0x70 | (bytes[6]! & 0x0f)
  bytes[8] = 0x80 | (bytes[8]! & 0x3f)

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
