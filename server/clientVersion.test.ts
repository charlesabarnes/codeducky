import { afterAll, describe, expect, it } from 'bun:test'
import { buildIdAt, CLIENT_HEADER } from '../shared/clientVersion'
import { MIN_CLIENT_BUILD } from './clientVersion'
import { login, makeApp } from './testing'

const MINIMUM = '20261004120000'
const made = makeApp({ minClientBuild: MINIMUM })
afterAll(() => made.cleanup())

const tokens = (token: string, build?: string) =>
  made.app.request('/api/auth/tokens', {
    headers: { Authorization: `Bearer ${token}`, ...(build === undefined ? {} : { [CLIENT_HEADER]: build }) },
  })

describe('client build handshake', () => {
  it('serves clients at or above the minimum', async () => {
    const token = await login(made.app)
    expect((await tokens(token, MINIMUM)).status).toBe(200)
    expect((await tokens(token, '20270101000000')).status).toBe(200)
  })

  it('refuses older or malformed builds with 426 and the minimum', async () => {
    const token = await login(made.app)
    for (const build of ['20261004115959', 'dev', '']) {
      const res = await tokens(token, build)
      expect(res.status, build).toBe(426)
      expect(await res.json()).toEqual({ error: 'client_outdated', minimum: MINIMUM })
    }
  })

  it('checks the build before authentication', async () => {
    const res = await made.app.request('/api/sync', { method: 'POST', headers: { [CLIENT_HEADER]: '20200101000000' } })
    expect(res.status).toBe(426)
  })

  it('leaves requests without the header alone', async () => {
    const token = await login(made.app)
    expect((await tokens(token)).status).toBe(200)
    expect((await made.app.request('/api/health')).status).toBe(200)
    expect((await made.app.request('/.well-known/oauth-protected-resource/mcp')).status).toBe(200)
  })

  it('accepts the builds made from this commit onwards', () => {
    expect(MIN_CLIENT_BUILD <= buildIdAt(new Date())).toBe(true)
  })
})
