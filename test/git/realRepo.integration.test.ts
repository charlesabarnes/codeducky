import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HandleFs } from '../../src/fs/handleFs'
import { listChanges } from '../../src/git/changes'
import { createContext } from '../../src/git/context'
import { createGitService } from '../../src/git/service'
import type { FileChange } from '../../src/git/types'
import { nodeDirectoryHandle } from '../support/nodeHandle'

const TSUNDOKU = process.env.TSUNDOKU_REPO ?? '/Users/charlesbarnes/Documents/dev/tsundoku'
const EXTRA_REPOS = (process.env.EXTRA_REPOS ?? '').split(',').filter(Boolean)

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trimEnd()

const STATUS: Record<string, FileChange['status']> = { A: 'added', M: 'modified', D: 'deleted', T: 'modified' }

function expectedChanges(repo: string, mergeBase: string): Map<string, FileChange['status']> {
  const expected = new Map<string, FileChange['status']>()
  for (const line of git(repo, 'diff', '--no-renames', '--name-status', mergeBase).split('\n').filter(Boolean)) {
    const [code, path] = line.split('\t')
    expected.set(path!, STATUS[code!.charAt(0)]!)
  }
  for (const path of git(repo, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)) {
    expected.set(path, 'added')
  }
  return expected
}

async function scan(repo: string, baseBranch?: string) {
  const service = createGitService()
  const info = await service.open(nodeDirectoryHandle(repo))
  const base = await service.resolveBase(baseBranch ?? info.defaultBase!)
  const started = performance.now()
  const changes = await service.changes(base.mergeBaseSha)
  const elapsedMs = Math.round(performance.now() - started)
  return { service, info, base, changes, elapsedMs }
}

async function compareWithCli(repo: string, baseBranch?: string) {
  const result = await scan(repo, baseBranch)
  const { info, base, changes } = result
  expect(info.headSha).toBe(git(repo, 'rev-parse', 'HEAD'))
  expect(base.baseTipSha).toBe(git(repo, 'rev-parse', `origin/${base.baseBranch}`))
  expect(base.mergeBaseSha).toBe(git(repo, 'merge-base', 'HEAD', `origin/${base.baseBranch}`))

  const expected = expectedChanges(repo, base.mergeBaseSha)
  const actual = new Map(changes.map((change) => [change.path, change.status]))
  expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected))
  return result
}

describe.skipIf(!existsSync(join(TSUNDOKU, '.git')))('tsundoku (read-only)', () => {
  it('matches git diff against the merge base plus untracked files', async () => {
    const { info, base, changes, elapsedMs } = await compareWithCli(TSUNDOKU)
    console.info(
      `tsundoku: branch=${info.branch} base=origin/${base.baseBranch} mergeBase=${base.mergeBaseSha.slice(0, 7)} ` +
        `changes=${changes.length} scan=${elapsedMs}ms`,
    )
  })
})

describe.skipIf(!existsSync(join(TSUNDOKU, '.git')))('modified clone of tsundoku with packfiles', () => {
  let work = ''

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'rubberduck-it-'))
    git(work, 'clone', '--quiet', '--no-local', TSUNDOKU, 'repo')
    const repo = join(work, 'repo')
    git(repo, 'remote', 'set-url', 'origin', 'git@github.com:charlesabarnes/tsundoku.git')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'checkout', '--quiet', '-b', 'feature/review-me')

    const tracked = git(repo, 'ls-files').split('\n')
    const [first, second, third, fourth] = tracked.filter((path) => /\.(ts|tsx|md|json)$/.test(path))
    writeFileSync(join(repo, first!), readFileSync(join(repo, first!), 'utf8') + '\n// committed change\n')
    git(repo, 'commit', '--quiet', '-am', 'committed change')

    writeFileSync(join(repo, second!), 'rewritten\n')
    git(repo, 'add', second!)
    unlinkSync(join(repo, third!))
    writeFileSync(join(repo, fourth!), readFileSync(join(repo, fourth!), 'utf8').replace(/\n/, '\nunstaged edit\n'))

    mkdirSync(join(repo, 'notes/deep'), { recursive: true })
    writeFileSync(join(repo, 'notes/deep/untracked.md'), '# new\n')
    writeFileSync(join(repo, 'notes/.gitignore'), '*.log\n!keep.log\n')
    writeFileSync(join(repo, 'notes/drop.log'), 'ignored\n')
    writeFileSync(join(repo, 'notes/keep.log'), 'kept\n')
    mkdirSync(join(repo, 'node_modules/some-pkg'), { recursive: true })
    writeFileSync(join(repo, 'node_modules/some-pkg/index.js'), 'ignored\n')
    writeFileSync(join(repo, 'staged-new.txt'), 'staged\n')
    git(repo, 'add', 'staged-new.txt')

    git(repo, 'gc', '--quiet')
    git(repo, 'pack-refs', '--all')
  })

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true })
  })

  it('reads packed objects and packed refs and matches git', async () => {
    const repo = join(work, 'repo')
    expect(readFileSync(join(repo, '.git/packed-refs'), 'utf8')).toContain('refs/remotes/origin/main')
    const { info, changes } = await compareWithCli(repo, 'main')
    expect(info).toMatchObject({ owner: 'charlesabarnes', name: 'tsundoku', branch: 'feature/review-me' })
    expect(info.baseBranches).toContain('main')
    const paths = changes.map((change) => change.path)
    expect(paths).toContain('notes/keep.log')
    expect(paths).toContain('staged-new.txt')
    expect(paths).not.toContain('notes/drop.log')
    expect(paths.some((path) => path.startsWith('node_modules/'))).toBe(false)
  })

  it('never lists ignored directories', async () => {
    const repo = join(work, 'repo')
    const fs = new HandleFs(nodeDirectoryHandle(repo))
    const listed: string[] = []
    const readdir = fs.promises.readdir
    fs.promises.readdir = async (path: string) => {
      listed.push(path)
      return readdir(path)
    }
    const readdirTyped = fs.readdirTyped.bind(fs)
    fs.readdirTyped = async (path: string) => {
      listed.push(path)
      return readdirTyped(path)
    }
    await listChanges(createContext(fs), git(repo, 'merge-base', 'HEAD', 'origin/main'))
    expect(listed.some((path) => path.includes('node_modules'))).toBe(false)
    expect(listed.some((path) => path.includes('notes'))).toBe(true)
  })

  it('returns old and new contents that match git', async () => {
    const repo = join(work, 'repo')
    const { service, base, changes } = await scan(repo, 'main')
    for (const change of changes) {
      const contents = await service.contents(change)
      if (change.status !== 'added') {
        const old = git(repo, 'show', `${base.mergeBaseSha}:${change.path}`)
        expect(contents.old?.kind === 'text' && contents.old.text.trimEnd()).toBe(old)
      } else {
        expect(contents.old).toBeNull()
      }
      if (change.status !== 'deleted') {
        expect(contents.new?.kind === 'text' && contents.new.text).toBe(readFileSync(join(repo, change.path), 'utf8'))
      } else {
        expect(contents.new).toBeNull()
      }
    }
    const stats = await service.stats(changes)
    expect(Object.keys(stats).sort()).toEqual(changes.map((change) => change.path).sort())
  })
})

describe.skipIf(EXTRA_REPOS.length === 0)('extra read-only repos', () => {
  it.each(EXTRA_REPOS)('%s matches git', async (repo) => {
    const { info, base, changes, elapsedMs } = await compareWithCli(repo)
    console.info(`${repo}: branch=${info.branch} base=origin/${base.baseBranch} changes=${changes.length} scan=${elapsedMs}ms`)
  })
})
