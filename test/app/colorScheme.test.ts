import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DARK_QUERY, prefersDark, resolveTheme } from '../../src/app/colorScheme'

type Scheme = 'dark' | 'light' | 'no-preference'

/** A matchMedia that answers like a browser whose OS reports the given scheme. */
function matchMediaFor(scheme: Scheme) {
  return (query: string) => ({
    matches: query === `(prefers-color-scheme: ${scheme})`,
    addEventListener: () => {},
  })
}

const throwing = () => {
  throw new Error('matchMedia is unavailable')
}

const ENVIRONMENTS = [
  ['no matchMedia', undefined, 'light'],
  ['a throwing matchMedia', throwing, 'light'],
  ['no OS preference', matchMediaFor('no-preference'), 'light'],
  ['an OS light preference', matchMediaFor('light'), 'light'],
  ['an OS dark preference', matchMediaFor('dark'), 'dark'],
] as const

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('prefersDark', () => {
  it.each(ENVIRONMENTS)('with %s gives %s', (_, matchMedia, theme) => {
    vi.stubGlobal('window', { matchMedia })
    expect(prefersDark()).toBe(theme === 'dark')
  })

  it('is false without a window', () => {
    vi.stubGlobal('window', undefined)
    expect(prefersDark()).toBe(false)
  })

  it('asks for dark, not light', () => {
    const matchMedia = vi.fn(matchMediaFor('dark'))
    vi.stubGlobal('window', { matchMedia })
    prefersDark()
    expect(matchMedia).toHaveBeenCalledWith(DARK_QUERY)
  })
})

describe('resolveTheme', () => {
  it('follows the OS for system', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('keeps an explicit choice whatever the OS says', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
  })
})

describe('index.html first paint', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''

  function firstPaint(matchMedia: unknown, cache: Record<string, string> = {}) {
    const dataset: Record<string, string> = { theme: 'light', palette: 'solar' }
    const localStorage = { getItem: (key: string) => cache[key] ?? null }
    runInNewContext(script, { window: { matchMedia }, localStorage, document: { documentElement: { dataset } } })
    return dataset
  }

  it('starts as solar light before any script runs', () => {
    expect(html).toContain('data-theme="light" data-palette="solar"')
    expect(html).toMatch(/<meta name="theme-color" content="#fcf5e3" \/>/)
  })

  it.each(ENVIRONMENTS)('with %s paints %s', (_, matchMedia, theme) => {
    expect(firstPaint(matchMedia)).toEqual({ theme, palette: 'solar' })
  })

  it('uses the cached choice over the OS', () => {
    const cache = { 'rubberduck.theme': 'light', 'rubberduck.palette': 'terminal' }
    expect(firstPaint(matchMediaFor('dark'), cache)).toEqual({ theme: 'light', palette: 'terminal' })
  })

  it('follows the OS when the cached theme is system', () => {
    expect(firstPaint(matchMediaFor('dark'), { 'rubberduck.theme': 'system' }).theme).toBe('dark')
  })

  it('still detects the OS when storage is blocked', () => {
    const dataset: Record<string, string> = {}
    const localStorage = { getItem: throwing }
    runInNewContext(script, { window: { matchMedia: matchMediaFor('dark') }, localStorage, document: { documentElement: { dataset } } })
    expect(dataset.theme).toBe('dark')
  })
})
