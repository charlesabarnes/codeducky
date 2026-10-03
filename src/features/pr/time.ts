const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/** "3 days ago", "just now". */
export function timeAgo(iso: string, now = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const elapsed = now - at
  for (const [unit, ms] of UNITS) if (Math.abs(elapsed) >= ms) return format.format(-Math.round(elapsed / ms), unit)
  return 'just now'
}

/** "3d", "5h", "12m": compact ages for the inbox. */
export function shortAge(iso: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(iso))
  if (Number.isNaN(elapsed)) return ''
  if (elapsed >= 365 * 86_400_000) return `${Math.floor(elapsed / (365 * 86_400_000))}y`
  if (elapsed >= 7 * 86_400_000) return `${Math.floor(elapsed / (7 * 86_400_000))}w`
  if (elapsed >= 86_400_000) return `${Math.floor(elapsed / 86_400_000)}d`
  if (elapsed >= 3_600_000) return `${Math.floor(elapsed / 3_600_000)}h`
  return `${Math.max(1, Math.floor(elapsed / 60_000))}m`
}
