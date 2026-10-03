import Anthropic from '@anthropic-ai/sdk'
import type { UsageEntry } from './types'

export type ClaudeErrorKind =
  | 'auth'
  | 'permission'
  | 'billing'
  | 'model'
  | 'bad-request'
  | 'rate-limit'
  | 'overloaded'
  | 'server'
  | 'network'
  | 'refusal'
  | 'truncated'
  | 'output'
  | 'cancelled'

export interface ClaudeFailure {
  kind: ClaudeErrorKind
  message: string
  /** Fatal failures stop the whole pass: every other request would fail the same way. */
  fatal: boolean
}

export class ClaudeOutputError extends Error {
  readonly kind: 'refusal' | 'truncated' | 'output'
  /** Tokens spent on the response that could not be used. */
  usage: UsageEntry[] = []
  constructor(kind: 'refusal' | 'truncated' | 'output', message: string) {
    super(message)
    this.kind = kind
  }
}

const detail = (error: InstanceType<typeof Anthropic.APIError>) => {
  const body = error.error as { error?: { message?: string } } | undefined
  return body?.error?.message ?? error.message
}

export function describeClaudeError(error: unknown, model: string): ClaudeFailure {
  if (error instanceof ClaudeOutputError) return { kind: error.kind, message: error.message, fatal: false }
  if (error instanceof Anthropic.APIUserAbortError) return { kind: 'cancelled', message: 'Cancelled.', fatal: false }
  if (error instanceof Anthropic.AuthenticationError) {
    return { kind: 'auth', message: 'The Anthropic API key was rejected. Check it in Settings.', fatal: true }
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return { kind: 'permission', message: `This API key is not allowed to do that: ${detail(error)}`, fatal: true }
  }
  if (error instanceof Anthropic.NotFoundError) {
    return { kind: 'model', message: `Model "${model}" was not found or is not available to this key. Check Settings.`, fatal: true }
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { kind: 'rate-limit', message: 'Rate limited by the API after several retries. Wait a minute, then retry.', fatal: false }
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { kind: 'bad-request', message: `The API rejected the request: ${detail(error)}`, fatal: false }
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { kind: 'network', message: 'Could not reach the Anthropic API. Check the connection, then retry.', fatal: false }
  }
  if (error instanceof Anthropic.APIError) {
    if (error.status === 402) return { kind: 'billing', message: `Billing problem: ${detail(error)}`, fatal: true }
    if (error.status === 529 || error.type === 'overloaded_error') {
      return { kind: 'overloaded', message: 'The API is overloaded and retries ran out. Try again shortly.', fatal: false }
    }
    if (typeof error.status === 'number' && error.status >= 500) {
      return { kind: 'server', message: `The API failed with ${error.status} after retries. Try again shortly.`, fatal: false }
    }
    return { kind: 'bad-request', message: detail(error), fatal: false }
  }
  return { kind: 'output', message: error instanceof Error ? error.message : String(error), fatal: false }
}
