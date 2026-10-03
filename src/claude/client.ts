import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessage, BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { ClaudeOutputError } from './errors'
import { FINDINGS_SCHEMA, parseFindings } from './parse'
import { userPrompt } from './prompt'
import type { ChunkResult, ReviewChunk, UsageEntry } from './types'

export const MAX_RETRIES = 4
const MAX_TOKENS = 64000
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export interface ClientOptions {
  apiKey: string
  fetch?: typeof fetch
  maxRetries?: number
}

export function createClaudeClient({ apiKey, fetch, maxRetries = MAX_RETRIES }: ClientOptions): Anthropic {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries, ...(fetch ? { fetch } : {}) })
}

/** Models from before adaptive thinking and the effort parameter. */
const LEGACY_MODEL = /haiku|claude-3|claude-(opus|sonnet)-4(-[015])?(-\d{8})?$/

/** Models that take the server-side refusal fallback in its "default" form. */
const FALLBACK_MODEL = /^claude-(opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/

export function buildRequest(model: string, system: string, chunk: ReviewChunk): BetaMessageStreamParams {
  const request: BetaMessageStreamParams = {
    model,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt(chunk) }],
    output_config: { format: { type: 'json_schema', schema: FINDINGS_SCHEMA as unknown as Record<string, unknown> } },
  }
  if (!LEGACY_MODEL.test(model)) {
    request.thinking = { type: 'adaptive' }
    request.output_config = { ...request.output_config, effort: 'high' }
  }
  if (FALLBACK_MODEL.test(model)) {
    request.betas = [FALLBACK_BETA]
    request.fallbacks = 'default'
  }
  return request
}

export function usageEntries(message: BetaMessage): UsageEntry[] {
  const { usage } = message
  const iterations = usage.iterations?.filter((entry) => entry.type === 'message' || entry.type === 'fallback_message')
  if (iterations && iterations.length > 0) {
    return iterations.map((entry) => ({
      model: ('model' in entry && entry.model) || message.model,
      inputTokens: entry.input_tokens,
      outputTokens: entry.output_tokens,
      cacheWriteTokens: entry.cache_creation_input_tokens ?? 0,
      cacheReadTokens: entry.cache_read_input_tokens ?? 0,
    }))
  }
  return [
    {
      model: message.model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    },
  ]
}

export function readFindings(message: BetaMessage, path: string): Omit<ChunkResult, 'usage'> {
  if (message.stop_reason === 'refusal') {
    throw new ClaudeOutputError('refusal', 'Claude declined to review this part of the file.')
  }
  if (message.stop_reason === 'max_tokens') {
    throw new ClaudeOutputError('truncated', 'The response hit the output limit before it finished.')
  }
  const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
  if (text.trim() === '') throw new ClaudeOutputError('output', 'Claude returned no findings output.')
  try {
    return parseFindings(text, path)
  } catch (error) {
    throw new ClaudeOutputError('output', error instanceof Error ? error.message : String(error))
  }
}

export type ChunkReviewer = (chunk: ReviewChunk, signal: AbortSignal) => Promise<ChunkResult>

export function chunkReviewer(client: Anthropic, model: string, system: string): ChunkReviewer {
  return async (chunk, signal) => {
    const message = await client.beta.messages.stream(buildRequest(model, system, chunk), { signal }).finalMessage()
    const usage = usageEntries(message)
    try {
      return { ...readFindings(message, chunk.path), usage }
    } catch (error) {
      if (error instanceof ClaudeOutputError) error.usage = usage
      throw error
    }
  }
}
