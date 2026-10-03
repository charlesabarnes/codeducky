import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGitService } from '../../src/git/service'
import { createGitHubClient } from '../../src/github/client'
import { githubBaseChanges } from '../../src/github/remoteBase'
import { nodeDirectoryHandle } from '../support/nodeHandle'
import { mockFetch } from './mockFetch'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd()
const ref = { owner: 'me', name: 'shallow' }

const A_BASE = 'export const a = 1\nexport const shared = true\n'

describe('diffing against a GitHub base that is not in the local object store', () => {
  let work = ''
  let upstream = ''
  let shallow = ''
  let baseSha = ''

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'skelbert-ghbase-'))
    upstream = join(work, 'upstream')
    mkdirSync(join(upstream, 'lib'), { recursive: true })
    git(upstream, 'init', '--quiet', '-b', 'main')
    git(upstream, 'config', 'user.email', 'test@example.com')
    git(upstream, 'config', 'user.name', 'Test')
    writeFileSync(join(upstream, 'a.ts'), A_BASE)
    writeFileSync(join(upstream, 'b.ts'), 'export const b = 1\n')
    writeFileSync(join(upstream, 'gone.ts'), 'export const gone = 1\n')
    writeFileSync(join(upstream, 'lib', 'x.ts'), 'export const x = 1\n')
    git(upstream, 'add', '.')
    git(upstream, 'commit', '--quiet', '-m', 'base')
    baseSha = git(upstream, 'rev-parse', 'HEAD')

    git(upstream, 'checkout', '--quiet', '-b', 'feature')
    writeFileSync(join(upstream, 'a.ts'), A_BASE.replace('= 1', '= 2'))
    writeFileSync(join(upstream, 'c.ts'), 'export const c = 1\n')
    git(upstream, 'rm', '--quiet', 'gone.ts')
    git(upstream, 'add', '.')
    git(upstream, 'commit', '--quiet', '-m', 'feature')

    shallow = join(work, 'shallow')
    git(work, 'clone', '--quiet', '--depth', '1', '--branch', 'feature', `file://${upstream}`, 'shallow')
    for (const dir of [upstream, shallow]) {
      writeFileSync(join(dir, 'b.ts'), 'export const b = 2\n')
      writeFileSync(join(dir, 'd.ts'), 'export const d = 1\n')
    }
  })

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true })
  })

  const github = () => {
    const tree = git(upstream, 'ls-tree', '-r', '--full-tree', baseSha)
      .split('\n')
      .map((line) => {
        const [meta, path] = line.split('\t')
        const [mode, type, sha] = meta!.split(' ')
        return { path: path!, mode: mode!, type: type!, sha: sha! }
      })
    const blobRoutes = tree.map((entry) => ({
      match: new RegExp(`/git/blobs/${entry.sha}$`),
      body: {
        sha: entry.sha,
        encoding: 'base64',
        content: execFileSync('git', ['cat-file', 'blob', entry.sha], { cwd: upstream }).toString('base64'),
      },
    }))
    const mock = mockFetch([
      { match: new RegExp(`/git/trees/${baseSha}\\?recursive=1$`), body: { sha: baseSha, truncated: false, tree } },
      ...blobRoutes,
    ])
    return { ...mock, tree, gh: createGitHubClient({ token: 't', fetch: mock.fetch }) }
  }

  it('lists changes from the GitHub tree and fetches only base blobs that are missing locally', async () => {
    const service = createGitService()
    await service.open(nodeDirectoryHandle(shallow))
    expect(await service.hasCommit(baseSha)).toBe(false)

    const { gh, calls, tree } = github()
    const changes = await githubBaseChanges(service, gh, ref, baseSha)
    expect(Object.fromEntries(changes.map((change) => [change.path, change.status]))).toEqual({
      'a.ts': 'modified',
      'b.ts': 'modified',
      'c.ts': 'added',
      'd.ts': 'added',
      'gone.ts': 'deleted',
    })

    const fetchedBlobs = calls.filter((call) => call.url.pathname.includes('/git/blobs/')).map((call) => call.url.pathname)
    const shaOf = (path: string) => tree.find((entry) => entry.path === path)!.sha
    // b.ts is unchanged in the shallow HEAD commit, so its base blob is already local.
    expect(fetchedBlobs.sort()).toEqual(
      ['a.ts', 'gone.ts'].map((path) => `/repos/me/shallow/git/blobs/${shaOf(path)}`).sort(),
    )

    const a = await service.contents(changes.find((change) => change.path === 'a.ts')!)
    expect(a.old).toMatchObject({ kind: 'text', text: A_BASE })
    expect(a.new).toMatchObject({ kind: 'text', text: A_BASE.replace('= 1', '= 2') })
  })

  it('agrees with the local diff when the base commit is available', async () => {
    const service = createGitService()
    await service.open(nodeDirectoryHandle(upstream))
    const { tree } = github()
    const oids = Object.fromEntries(tree.map((entry) => [entry.path, entry.sha]))
    expect(await service.changesAgainstOids(oids)).toEqual(await service.changes(baseSha))
  })
})
