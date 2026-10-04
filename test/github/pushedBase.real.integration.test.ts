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

/**
 * Runs against the real charlesabarnes/rubberduck repo, so it is opt-in: RUBBERDUCK_REAL_GITHUB=1.
 * Pushes two temporary branches, which are deleted afterwards. The token comes from `gh auth token`.
 */
const enabled = process.env.RUBBERDUCK_REAL_GITHUB === '1'
const URL = 'https://github.com/charlesabarnes/rubberduck.git'
const ref = { owner: 'charlesabarnes', name: 'rubberduck' }
const BASE = 'e2e/base-check-base'
const FEATURE = 'e2e/base-check'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd()

function commit(dir: string, file: string, message: string) {
  writeFileSync(join(dir, file), `${message}\n`)
  git(dir, 'add', '.')
  git(dir, 'commit', '--quiet', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

function clone(work: string, name: string) {
  git(work, 'clone', '--quiet', URL, name)
  const dir = join(work, name)
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Rubberduck e2e')
  return dir
}

describe.skipIf(!enabled)('GitHub base against the real repo', () => {
  let work = ''
  let other = ''
  let local = ''
  let pushed = ''

  beforeAll(() => {
    expect(git(process.cwd(), 'ls-remote', URL, `refs/heads/${BASE}`, `refs/heads/${FEATURE}`)).toBe('')
    work = mkdtempSync(join(tmpdir(), 'rubberduck-real-'))
    other = clone(work, 'other')
    git(other, 'checkout', '--quiet', '-b', BASE, 'origin/main')
    commit(other, 'e2e-b0.txt', 'base 0')
    git(other, 'push', '--quiet', 'origin', BASE)

    local = clone(work, 'local')
    git(local, 'checkout', '--quiet', '-b', FEATURE, `origin/${BASE}`)
    commit(local, 'e2e-f1.txt', 'feature 1')
    git(local, 'push', '--quiet', 'origin', FEATURE)

    // The base moves on GitHub; the feature merges it by URL, so the local origin/<base> stays stale.
    commit(other, 'e2e-b1.txt', 'base 1')
    git(other, 'push', '--quiet', 'origin', BASE)
    git(local, 'pull', '--quiet', '--no-rebase', '--no-edit', URL, BASE)
    git(local, 'push', '--quiet', 'origin', FEATURE)
    pushed = git(local, 'rev-parse', 'HEAD')

    commit(other, 'e2e-b2.txt', 'base 2')
    git(other, 'push', '--quiet', 'origin', BASE)

    commit(local, 'e2e-l1.txt', 'local 1')
    commit(local, 'e2e-l2.txt', 'local 2')
  })

  afterAll(() => {
    if (other) {
      for (const branch of [FEATURE, BASE]) {
        try {
          git(other, 'push', '--quiet', 'origin', '--delete', branch)
        } catch {
          // Already gone.
        }
      }
    }
    if (work) rmSync(work, { recursive: true, force: true })
  })

  it('finds the merge base that a fresh fetch agrees with', async () => {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
    const gh = createGitHubClient({ token })
    const service = createGitService()
    await service.open(nodeDirectoryHandle(local))

    const base = await findGitHubBase(gh, ref, service, { baseBranch: BASE })

    const verify = clone(work, 'verify')
    const expected = git(verify, 'merge-base', `origin/${BASE}`, `origin/${FEATURE}`)
    expect(base).toEqual({
      headSha: git(local, 'rev-parse', 'HEAD'),
      baseSha: expected,
      githubBase: { branch: BASE, tipSha: git(verify, 'rev-parse', `origin/${BASE}`), pushedSha: pushed },
    })
    expect((await service.resolveBase(BASE)).mergeBaseSha).not.toBe(expected)

    const changes = await githubBaseChanges(service, gh, ref, base.baseSha)
    expect(changes.map((change) => change.path)).toEqual(['e2e-f1.txt', 'e2e-l1.txt', 'e2e-l2.txt'])
  })
})
