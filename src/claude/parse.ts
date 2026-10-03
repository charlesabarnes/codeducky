import { NOTE_SEVERITIES, type NoteSeverity } from '../db/schema'
import type { Finding } from './types'

export const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          side: { type: 'string', enum: ['old', 'new'] },
          line: { type: 'integer' },
          line_text: { type: 'string' },
          severity: { type: 'string', enum: [...NOTE_SEVERITIES] },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['path', 'side', 'line', 'line_text', 'severity', 'title', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const

export interface ParsedFindings {
  findings: Finding[]
  invalid: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function toFinding(raw: unknown, path: string): Finding | null {
  if (!isRecord(raw)) return null
  const { side, line, line_text, severity, title, body } = raw
  if (side !== 'old' && side !== 'new') return null
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null
  if (typeof line_text !== 'string' || typeof title !== 'string' || typeof body !== 'string') return null
  if (!NOTE_SEVERITIES.includes(severity as NoteSeverity)) return null
  if (title.trim() === '') return null
  return { path, side, line, lineText: line_text, severity: severity as NoteSeverity, title: title.trim(), body: body.trim() }
}

/** Parses the structured output text. The path is forced to the requested file, since each request covers one file. */
export function parseFindings(text: string, path: string): ParsedFindings {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Claude returned output that is not valid JSON.')
  }
  if (!isRecord(data) || !Array.isArray(data.findings)) throw new Error('Claude returned output without a findings list.')
  const findings: Finding[] = []
  let invalid = 0
  for (const raw of data.findings) {
    const finding = toFinding(raw, path)
    if (finding) findings.push(finding)
    else invalid++
  }
  return { findings, invalid }
}
