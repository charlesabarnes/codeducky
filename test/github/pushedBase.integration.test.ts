import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGitService } from '../../src/git/service'
import { createGitHubClient } from '../../src/github/client'
import { findGitHubBase } from '../../src/github/pushedBase'
import { githubBaseChanges } from '../../src/github/remoteBase'
import { nodeDirectoryHandle } from '../support/nodeHandle'
import { mockFetch, type MockRoute } from './mockFetch'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd()
const ref = { owner: 'me', name: 'unpushed' }

function commit(dir: string, file: string, text: string, message: string) {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', '.')
  git(dir, 'commit', '--quiet', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

function clone(work: string, bare: string, name: string) {
  git(work, 'clone', '--quiet', bare, name)
  const dir = join(work, name)
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  return dir
}

/** A mocked GitHub that answers from the bare repo standing in for it. */
function githubFor(bare: string, local: string) {
  const known = (sha: string) => {
    try {
      git(bare, 'cat-file', '-e', `${sha}^{commit}`)
      return true
    } catch {
      return false
    }
  }
  const tip = git(bare, 'rev-parse', 'main')
  const chain = git(local, 'rev-list', '--first-parent', 'HEAD').split('\n')
  const routes: MockRoute[] = [{ match: /\/git\/ref\/heads\/main$/, body: { object: { sha: tip } } }]
  for (const sha of chain) {
    routes.push(
      known(sha)
        ? { match: new RegExp(`/commits/${sha}$`), body: { sha } }
        : { match: new RegExp(`/commits/${sha}$`), status: 422, body: { message: 'No commit found for SHA' } },
    )
    if (known(sha)) {
      const mergeBase = git(bare, 'merge-base', tip, sha)
      routes.push({
        match: new RegExp(`/compare/${tip}\\.\\.\\.${sha}$`),
        body: { status: 'diverged', ahead_by: 1, behind_by: 1, merge_base_commit: { sha: mergeBase } },
      })
    }
  }
  return mockFetch(routes)
}

describe('GitHub base for a HEAD that is not pushed', () => {
  let work = ''
  let bare = ''
  let local = ''
  const shas: Record<string, string> = {}

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'rubberduck-pushed-'))
    bare = join(work, 'github.git')
    git(work, 'init', '--quiet', '--bare', '-b', 'main', bare)
    const other = clone(work, bare, 'other')
    git(other, 'checkout', '--quiet', '-b', 'main')
    shas.m1 = commit(other, 'a.ts', 'export const a = 1\n', 'm1')
    git(other, 'push', '--quiet', 'origin', 'main')

    local = clone(work, bare, 'local')
    git(local, 'checkout', '--quiet', '-b', 'feature')
    commit(local, 'f.ts', 'export const f = 1\n', 'f1')
    git(local, 'push', '--quiet', '-u', 'origin', 'feature')

    // main moves on; the local branch merges it straight from the URL, so origin/main stays stale.
    shas.m2 = commit(other, 'm2.ts', 'export const m2 = 1\n', 'm2')
    git(other, 'push', '--quiet', 'origin', 'main')
    git(local, 'pull', '--quiet', '--no-rebase', '--no-edit', bare, 'main')
    git(local, 'push', '--quiet', 'origin', 'feature')
    shas.pushed = git(local, 'rev-parse', 'HEAD')

    shas.m3 = commit(other, 'm3.ts', 'export const m3 = 1\n', 'm3')
    git(other, 'push', '--quiet', 'origin', 'main')

    commit(local, 'l1.ts', 'export const l1 = 1\n', 'local 1')
    shas.head = commit(local, 'f.ts', 'export const f = 2\n', 'local 2')
  })

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true })
  })

  it('uses the last pushed commit for compare and keeps unpushed commits in the diff', async () => {
    const service = createGitService()
    await service.open(nodeDirectoryHandle(local))
    expect((await service.resolveBase('main')).mergeBaseSha).toBe(shas.m1)

    const { fetch } = githubFor(bare, local)
    const gh = createGitHubClient({ token: 't', fetch })
    const base = await findGitHubBase(gh, ref, service, { baseBranch: 'main' })
    expect(base).toEqual({
      headSha: shas.head,
      baseSha: shas.m2,
      githubBase: { branch: 'main', tipSha: shas.m3, pushedSha: shas.pushed },
    })

    const changes = await githubBaseChanges(service, gh, ref, base.baseSha)
    expect(Object.fromEntries(changes.map((change) => [change.path, change.status]))).toEqual({
      'f.ts': 'added',
      'l1.ts': 'added',
    })
    const localChanges = await service.changes(shas.m1!)
    expect(localChanges.map((change) => change.path)).toContain('m2.ts')
  })

  it('walks first parents only, newest first', async () => {
    const service = createGitService()
    await service.open(nodeDirectoryHandle(local))
    expect(await service.firstParents(3)).toEqual(git(local, 'rev-list', '--first-parent', '-n', '3', 'HEAD').split('\n'))
  })
})
