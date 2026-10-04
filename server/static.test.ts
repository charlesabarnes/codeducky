import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeApp } from './testing'

let dist: string
let made: ReturnType<typeof makeApp>

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'rubberduck-dist-'))
  mkdirSync(join(dist, 'assets'))
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Rubberduck</title>')
  writeFileSync(join(dist, 'sw.js'), 'self.addEventListener("fetch", () => {})')
  writeFileSync(join(dist, 'manifest.webmanifest'), '{}')
  writeFileSync(join(dist, 'assets', 'index-AbC123xy.js'), 'console.log(1)')
  made = makeApp({ webDist: dist })
})

afterAll(() => {
  made.cleanup()
  rmSync(dist, { recursive: true, force: true })
})

describe('static', () => {
  it('serves fingerprinted assets as immutable', async () => {
    const res = await made.app.request('/assets/index-AbC123xy.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('immutable')
    expect(res.headers.get('Content-Type')).toContain('javascript')
  })

  it('makes the service worker, manifest and index revalidate', async () => {
    for (const path of ['/sw.js', '/manifest.webmanifest', '/index.html', '/']) {
      const res = await made.app.request(path)
      expect(res.status).toBe(200)
      expect(res.headers.get('Cache-Control')).toBe('no-cache')
    }
    expect((await made.app.request('/sw.js')).headers.get('Content-Type')).toContain('javascript')
  })

  it('falls back to index.html for app routes and 404s missing files and API paths', async () => {
    const route = await made.app.request('/sessions/0190-abc')
    expect(route.status).toBe(200)
    expect(await route.text()).toContain('<title>Rubberduck</title>')
    expect((await made.app.request('/assets/missing-12345678.js')).status).toBe(404)
    expect((await made.app.request('/../package.json')).status).toBe(404)
    const api = await made.app.request('/api/nope')
    expect(api.status).toBe(404)
    expect(await api.json()).toEqual({ error: 'not_found' })
    expect((await made.app.request('/api/health')).status).toBe(200)
  })

  it('serves the app for pull request deep links, including github.com-shaped ones', async () => {
    for (const path of ['/pr/charlesabarnes/rubberduck/12', '/charlesabarnes/rubberduck/pull/12', '/charlesabarnes/rubberduck/pull/12/files', '/charlesabarnes/rubberduck/pull/12/commits', '/inbox']) {
      const res = await made.app.request(path)
      expect(res.status, path).toBe(200)
      expect(await res.text()).toContain('<title>Rubberduck</title>')
    }
  })
})
