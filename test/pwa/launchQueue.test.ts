import 'fake-indexeddb/auto'
import { matchRoutes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { prUrl, sessionUrl } from '../../shared/links'
import { isServerPath } from '../../shared/serverPaths'
import { routes } from '../../src/app/routes'
import { handleLaunches } from '../../src/pwa/launchQueue'

const ORIGIN = 'https://codeducky.example'

function launch(targetURL: string | undefined, href = `${ORIGIN}/`) {
  let consumer: ((params: LaunchParams) => void) | undefined
  const navigate = vi.fn()
  const openServerPage = vi.fn()
  handleLaunches({
    launchQueue: { setConsumer: (fn) => (consumer = fn) },
    location: { origin: ORIGIN, href },
    navigate,
    openServerPage,
  })
  consumer!({ targetURL })
  return { navigate, openServerPage }
}

describe('handleLaunches', () => {
  it('navigates the open window to a launched session link', () => {
    const { navigate, openServerPage } = launch(sessionUrl(ORIGIN, 'abc 1'))
    expect(navigate).toHaveBeenCalledWith('/sessions/abc%201')
    expect(openServerPage).not.toHaveBeenCalled()
  })

  it('keeps the query and hash', () => {
    expect(launch(`${ORIGIN}/pr/o/r/3?file=a.ts#L4`).navigate).toHaveBeenCalledWith('/pr/o/r/3?file=a.ts#L4')
  })

  it('ignores the launch that opened the current page, other origins and missing targets', () => {
    expect(launch(`${ORIGIN}/inbox`, `${ORIGIN}/inbox`).navigate).not.toHaveBeenCalled()
    expect(launch('https://elsewhere.example/sessions/x').navigate).not.toHaveBeenCalled()
    expect(launch(undefined).navigate).not.toHaveBeenCalled()
    expect(launch('not a url').navigate).not.toHaveBeenCalled()
  })

  it('hands server pages to the browser instead of the router', () => {
    const { navigate, openServerPage } = launch(`${ORIGIN}/oauth/authorize?client_id=x`)
    expect(openServerPage).toHaveBeenCalledWith(`${ORIGIN}/oauth/authorize?client_id=x`)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('hands launched files to openFiles instead of navigating to the handler URL', () => {
    let consumer: ((params: LaunchParams) => void) | undefined
    const navigate = vi.fn()
    const openFiles = vi.fn()
    handleLaunches({ launchQueue: { setConsumer: (fn) => (consumer = fn) }, location: { origin: ORIGIN, href: `${ORIGIN}/inbox` }, navigate, openServerPage: vi.fn(), openFiles })
    const files = [{ kind: 'file', name: 'fix.patch' }] as unknown as FileSystemHandle[]
    consumer!({ targetURL: `${ORIGIN}/`, files })
    expect(openFiles).toHaveBeenCalledWith(files)
    expect(navigate).not.toHaveBeenCalled()
    consumer!({ targetURL: `${ORIGIN}/`, files: [] })
    expect(navigate).toHaveBeenCalledWith('/')
  })

  it('does nothing without launchQueue', () => {
    expect(handleLaunches({ launchQueue: undefined, location: { origin: ORIGIN, href: ORIGIN }, navigate: vi.fn(), openServerPage: vi.fn() })).toBe(false)
  })
})

describe('captured links', () => {
  it('session and pull request links from MCP, the channel and the gate are app routes inside the manifest scope', () => {
    for (const url of [sessionUrl(ORIGIN, 'sess-1'), sessionUrl(`${ORIGIN}/`, 'a/b'), prUrl(ORIGIN, { owner: 'o', name: 'r', number: 7 })]) {
      const { origin, pathname } = new URL(url)
      expect(origin).toBe(ORIGIN)
      expect(pathname.startsWith('/')).toBe(true)
      expect(isServerPath(pathname), pathname).toBe(false)
      expect(matchRoutes(routes, pathname)?.at(-1)?.route.id, pathname).toMatch(/^(session|pr)$/)
    }
  })
})
