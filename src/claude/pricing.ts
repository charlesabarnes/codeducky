import type { UsageEntry } from './types'

interface Price {
  input: number
  output: number
  cacheRead?: number
}

/** US dollars per million tokens, Anthropic first-party API list prices (September 2026). */
const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

const CACHE_WRITE_MULTIPLIER = 1.25
const CACHE_READ_MULTIPLIER = 0.1

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  requests: number
  /** Estimated cost in dollars; null when a model has no known price. */
  cost: number | null
  unpricedModels: string[]
}

export const EMPTY_TOTALS: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  requests: 0,
  cost: 0,
  unpricedModels: [],
}

const priceFor = (model: string): Price | undefined => PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, '')]

export function entryCost(entry: UsageEntry): number | null {
  const price = priceFor(entry.model)
  if (!price) return null
  const cacheRead = price.cacheRead ?? price.input * CACHE_READ_MULTIPLIER
  return (
    (entry.inputTokens * price.input +
      entry.cacheWriteTokens * price.input * CACHE_WRITE_MULTIPLIER +
      entry.cacheReadTokens * cacheRead +
      entry.outputTokens * price.output) /
    1_000_000
  )
}

export function addUsage(totals: UsageTotals, entries: readonly UsageEntry[], requests = 1): UsageTotals {
  const next = { ...totals, unpricedModels: [...totals.unpricedModels], requests: totals.requests + requests }
  for (const entry of entries) {
    next.inputTokens += entry.inputTokens
    next.outputTokens += entry.outputTokens
    next.cacheWriteTokens += entry.cacheWriteTokens
    next.cacheReadTokens += entry.cacheReadTokens
    const cost = entryCost(entry)
    if (cost === null) {
      if (!next.unpricedModels.includes(entry.model)) next.unpricedModels.push(entry.model)
      next.cost = null
    } else if (next.cost !== null) {
      next.cost += cost
    }
  }
  return next
}

export function formatCost(cost: number | null): string {
  if (cost === null) return 'unknown'
  if (cost > 0 && cost < 0.01) return '< $0.01'
  return `$${cost.toFixed(2)}`
}
