export interface FakeReply {
  text?: string
  stopReason?: string
  model?: string
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
}

export interface RecordedRequest {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

/** A Messages API streaming response carrying one text block. */
export function streamReply({ text = '{"findings":[]}', stopReason = 'end_turn', model = 'claude-opus-5-5', usage = {} }: FakeReply): Response {
  const { input_tokens = 100, output_tokens = 20, cache_creation_input_tokens = 0, cache_read_input_tokens = 0 } = usage
  const body = [
    event('message_start', {
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens, output_tokens: 1, cache_creation_input_tokens, cache_read_input_tokens },
      },
    }),
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens } }),
    event('message_stop', {}),
  ].join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

export function errorReply(status: number, type: string, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** A fetch stand-in that serves queued replies in order, or answers each request, and records every request. */
export function fakeFetch(replies: (() => Response)[] | ((request: RecordedRequest) => Response)) {
  const requests: RecordedRequest[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    init?.signal?.throwIfAborted()
    const request = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) }
    requests.push(request)
    if (typeof replies === 'function') return replies(request)
    const next = replies.shift()
    if (!next) throw new Error('No fake reply queued')
    return next()
  }
  return { fetch: fetch as typeof globalThis.fetch, requests }
}
