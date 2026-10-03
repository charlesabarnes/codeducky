import { createGitHubClient } from '../../src/github/client'

export interface FakeCall {
  method: string
  path: string
  body: Record<string, unknown> | undefined
}

export type FakeHandler = (call: FakeCall & { url: URL }) => { status?: number; body: unknown } | undefined

/** A GitHub client over a handler that sees each request's method, path and parsed body (GraphQL included). */
export function fakeGitHub(handler: FakeHandler) {
  const calls: FakeCall[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    const call = { method, path: url.pathname, body }
    calls.push(call)
    const answer = handler({ ...call, url })
    if (!answer) throw new Error(`Unexpected request ${method} ${url}`)
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { gh: createGitHubClient({ token: 't', fetch }), calls }
}

export const base64 = (text: string | Uint8Array) =>
  Buffer.from(typeof text === 'string' ? new TextEncoder().encode(text) : text).toString('base64')
