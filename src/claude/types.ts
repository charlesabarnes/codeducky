import type { NoteSeverity, NoteSide } from '../db/schema'
import type { ChangeStatus } from '../git/types'

export interface Finding {
  path: string
  side: NoteSide
  line: number
  lineText: string
  severity: NoteSeverity
  title: string
  body: string
}

export interface ReviewChunk {
  path: string
  status: ChangeStatus
  part: number
  parts: number
  wholeFile: boolean
  diff: string
}

export interface UsageEntry {
  model: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

export interface ChunkResult {
  findings: Finding[]
  invalid: number
  usage: UsageEntry[]
}
