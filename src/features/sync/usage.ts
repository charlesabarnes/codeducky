import type { Usage } from '../../sync/controller'

const UNITS = ['B', 'KB', 'MB', 'GB'] as const

export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(1).replace(/\.0$/, '')
  return `${rounded} ${UNITS[unit]}`
}

/** "1.2 MB of 50 MB · 3,100 of 20,000 records" */
export function usageLine(usage: Usage, quota: Usage): string {
  const count = (n: number) => n.toLocaleString('en-US')
  return `${formatBytes(usage.bytes)} of ${formatBytes(quota.bytes)} · ${count(usage.records)} of ${count(quota.records)} records`
}

/** The fuller of the two limits, from 0 to 1. */
export function usageShare(usage: Usage, quota: Usage): number {
  const share = (used: number, limit: number) => (limit > 0 ? used / limit : 0)
  return Math.min(1, Math.max(share(usage.bytes, quota.bytes), share(usage.records, quota.records)))
}
