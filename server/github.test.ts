import { describe, expect, it } from 'bun:test'
import { GitHubError, githubProvider } from './auth/github'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

type Reply = Response | Error | (() => Promise<Response>)

/** A fetch that records each call and answers from a list, in order. */
function mockFetch(...replies: Reply[]) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: input.toString(),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const reply = replies.shift()
    if (!reply) throw new Error('unexpected call')
    if (reply instanceof Error) throw reply
    return typeof reply === 'function' ? reply() : reply
  }) as typeof fetch
  return { calls, fetch: fetchImpl }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const USER = { id: 583231, login: 'octocat', name: 'The Octocat', avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4' }
const params = { code: 'gh-code', verifier: 'v'.repeat(43), redirectUri: 'https://ducky.example/api/auth/github/callback' }

describe('github provider', () => {
  it('swaps the code with PKCE, reads /user, then revokes the token', async () => {
    const mock = mockFetch(json({ access_token: 'gho_secret', token_type: 'bearer', scope: '' }), json(USER), new Response(null, { status: 204 }))
    const provider = githubProvider({ clientId: 'Iv1.abc', clientSecret: 'shh', fetch: mock.fetch })
    expect(await provider.exchange(params)).toEqual({ id: 583231, login: 'octocat', name: 'The Octocat', avatarUrl: USER.avatar_url })

    const [token, user, revoke] = mock.calls
    expect(token).toMatchObject({
      url: 'https://github.com/login/oauth/access_token',
      method: 'POST',
      headers: { accept: 'application/json' },
      body: { client_id: 'Iv1.abc', client_secret: 'shh', code: 'gh-code', redirect_uri: params.redirectUri, code_verifier: params.verifier },
    })
    expect(user).toMatchObject({ url: 'https://api.github.com/user', headers: { authorization: 'Bearer gho_secret', 'user-agent': 'codeducky' } })
    expect(revoke).toMatchObject({
      url: 'https://api.github.com/applications/Iv1.abc/token',
      method: 'DELETE',
      headers: { authorization: `Basic ${Buffer.from('Iv1.abc:shh').toString('base64')}` },
      body: { access_token: 'gho_secret' },
    })
  })

  it('maps a refused code to a GitHubError without calling the API', async () => {
    const mock = mockFetch(json({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }))
    const provider = githubProvider({ clientId: 'id', clientSecret: 's', fetch: mock.fetch })
    const error = await provider.exchange(params).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitHubError)
    expect((error as Error).message).toContain('bad_verification_code')
    expect(mock.calls).toHaveLength(1)
  })

  it('maps server errors and still revokes the token', async () => {
    const mock = mockFetch(json({ access_token: 'gho_secret' }), json({ message: 'boom' }, 502), new Response(null, { status: 204 }))
    const provider = githubProvider({ clientId: 'id', clientSecret: 's', fetch: mock.fetch })
    const error = await provider.exchange(params).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitHubError)
    expect((error as Error).message).not.toContain('gho_secret')
    expect(mock.calls.map((c) => c.method)).toEqual(['POST', 'GET', 'DELETE'])
  })

  it('maps a 5xx from the token endpoint and a timeout', async () => {
    const down = githubProvider({ clientId: 'id', clientSecret: 's', fetch: mockFetch(new Response('oops', { status: 503 })).fetch })
    await expect(down.exchange(params)).rejects.toBeInstanceOf(GitHubError)

    const hangs = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch
    const slow = githubProvider({ clientId: 'id', clientSecret: 's', fetch: hangs, timeoutMs: 20 })
    await expect(slow.exchange(params)).rejects.toBeInstanceOf(GitHubError)
  })

  it('ignores a failed revoke', async () => {
    const mock = mockFetch(json({ access_token: 'gho_secret' }), json(USER), new TypeError('network down'))
    const provider = githubProvider({ clientId: 'id', clientSecret: 's', fetch: mock.fetch })
    expect((await provider.exchange(params)).login).toBe('octocat')
  })

  it('refuses a malformed user', async () => {
    const mock = mockFetch(json({ access_token: 't' }), json({ login: 'no-id' }), new Response(null, { status: 204 }))
    const provider = githubProvider({ clientId: 'id', clientSecret: 's', fetch: mock.fetch })
    await expect(provider.exchange(params)).rejects.toBeInstanceOf(GitHubError)
  })
})
