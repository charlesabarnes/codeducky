import 'fake-indexeddb/auto'
import { matchRoutes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { isServerPath, NAVIGATE_DENYLIST } from '../../shared/serverPaths'
import { fileWindowPath } from '../../src/app/paths'
import { routes } from '../../src/app/routes'

const leaf = (path: string) => matchRoutes(routes, path)?.at(-1)?.route.id ?? null

describe('routes', () => {
  it('opens pull requests from the canonical and the github.com-shaped paths', () => {
    expect(leaf('/pr/charlesabarnes/codeducky/12')).toBe('pr')
    for (const path of ['/charlesabarnes/codeducky/pull/12', '/charlesabarnes/codeducky/pull/12/files', '/charlesabarnes/codeducky/pull/12/commits', '/o/r/pull/3/commits/abc123']) {
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
    expect(leaf('/signin/callback')).toBe('signin-callback')
    expect(leaf('/repos/x/pull/1')).toBe('pr-mirror')
    expect(leaf('/charlesabarnes/codeducky')).toBeNull()
  })

  it('opens a session file in a window of its own, outside the app layout with its sidebar', () => {
    const path = new URL(fileWindowPath('patch-1', 'src/a.ts'), 'https://x').pathname
    expect(leaf(path)).toBe('file-window')
    const [shell] = matchRoutes(routes, path)!
    expect(shell!.route).toBe(routes[1])
    expect(matchRoutes(routes, '/sessions/abc')![0]!.route).toBe(routes[0])
  })

  it('handles the share target in the app, not the server or the service worker fallback denylist', () => {
    expect(leaf('/share')).toBe('share')
    expect(isServerPath('/share')).toBe(false)
    expect(NAVIGATE_DENYLIST.some((pattern) => pattern.test('/share?url=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1'))).toBe(false)
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
