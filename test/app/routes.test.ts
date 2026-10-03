import 'fake-indexeddb/auto'
import { matchRoutes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { isServerPath, NAVIGATE_DENYLIST } from '../../shared/serverPaths'
import { routes } from '../../src/app/routes'

const leaf = (path: string) => matchRoutes(routes, path)?.at(-1)?.route.id ?? null

describe('routes', () => {
  it('opens pull requests from the canonical and the github.com-shaped paths', () => {
    expect(leaf('/pr/charlesabarnes/skelbert/12')).toBe('pr')
    for (const path of ['/charlesabarnes/skelbert/pull/12', '/charlesabarnes/skelbert/pull/12/files', '/charlesabarnes/skelbert/pull/12/commits', '/o/r/pull/3/commits/abc123']) {
      expect(leaf(path), path).toBe('pr-mirror')
    }
  })

  it('keeps the app routes ahead of the mirror route', () => {
    expect(leaf('/')).toBe('repos')
    expect(leaf('/inbox')).toBe('inbox')
    expect(leaf('/settings')).toBe('settings')
    expect(leaf('/checklists')).toBe('checklists')
    expect(leaf('/sessions/abc')).toBe('session')
    expect(leaf('/repos/gh%3Aa%2Fb')).toBe('repo')
    expect(leaf('/repos/gh%3Aa%2Fb/history')).toBe('history')
    expect(leaf('/repos/x/pull/1')).toBe('pr-mirror')
    expect(leaf('/charlesabarnes/skelbert')).toBeNull()
  })

  it('leaves pull request paths to the app in the service worker and the server', () => {
    for (const path of ['/pr/o/r/1', '/o/r/pull/1', '/o/r/pull/1/files']) {
      expect(NAVIGATE_DENYLIST.some((pattern) => pattern.test(path)), path).toBe(false)
      expect(isServerPath(path), path).toBe(false)
    }
    expect(isServerPath('/api/sync')).toBe(true)
    expect(NAVIGATE_DENYLIST.some((pattern) => pattern.test('/mcp'))).toBe(true)
  })
})
