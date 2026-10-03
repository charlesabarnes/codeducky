import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { vi } from 'vitest'

export const fixture = <T = unknown>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as T

export const fixtureText = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')

export interface MockRoute {
  method?: string
  /** Matched against `pathname + search` of the request URL. */
  match: RegExp
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

export interface Call {
  method: string
  url: URL
  headers: Record<string, string>
  body: unknown
}

/** A fetch that answers from a route table, records every call and fails on anything unexpected. */
export function mockFetch(routes: MockRoute[]) {
  const calls: Call[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body })
    const route = routes.find(
      (r) => (r.method === '*' || (r.method ?? 'GET') === method) && r.match.test(url.pathname + url.search),
    )
    if (!route) throw new Error(`Unexpected request ${method} ${url}`)
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...route.headers },
    })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}
