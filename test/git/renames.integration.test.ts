import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGitService } from '../../src/git/service'
import { nodeDirectoryHandle } from '../support/nodeHandle'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd()

const body = (tag: string, count = 40) =>
  Array.from({ length: count }, (_, i) => `export const ${tag}${i} = compute('${tag}', ${i}) // line ${i}`).join('\n') + '\n'

function write(repo: string, path: string, text: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), text)
}

function move(repo: string, from: string, to: string) {
  mkdirSync(dirname(join(repo, to)), { recursive: true })
  renameSync(join(repo, from), join(repo, to))
}

/** What git itself reports, with renames at the same 50% threshold. */
function gitRenames(repo: string, base: string): Map<string, { from: string; score: number }> {
  git(repo, 'add', '-A')
  const out = git(repo, 'diff', '--cached', '-M50%', '--name-status', base)
  git(repo, 'reset', '--quiet')
  const renames = new Map<string, { from: string; score: number }>()
  for (const line of out.split('\n').filter(Boolean)) {
    const [code, from, to] = line.split('\t')
    if (code!.startsWith('R')) renames.set(to!, { from: from!, score: Number(code!.slice(1)) })
  }
  return renames
}

describe('rename detection through the git service', () => {
  let work = ''
  let repo = ''
  let base = ''

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'skelbert-renames-'))
    repo = join(work, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '--quiet', '-b', 'main')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    write(repo, 'src/exact.ts', body('exact'))
    write(repo, 'src/edited.ts', body('edited'))
    write(repo, 'src/rewritten.ts', body('rewritten'))
    write(repo, 'src/kept.ts', body('kept'))
    write(repo, 'docs/notes.md', body('notes', 10))
    git(repo, 'add', '-A')
    git(repo, 'commit', '--quiet', '-m', 'base')
    base = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '--quiet', '-b', 'feature')

    // Committed exact rename into another folder.
    move(repo, 'src/exact.ts', 'lib/exact.ts')
    git(repo, 'add', '-A')
    git(repo, 'commit', '--quiet', '-m', 'move exact')
    // Uncommitted rename with edits (about 80% similar).
    const edited = readFileSync(join(repo, 'src/edited.ts'), 'utf8').split('\n')
    for (let i = 0; i < 8; i++) edited[i * 5] = `export const changed${i} = 0`
    unlinkSync(join(repo, 'src/edited.ts'))
    write(repo, 'src/renamed.ts', edited.join('\n'))
    // Deleted and replaced by unrelated content: not a rename.
    unlinkSync(join(repo, 'src/rewritten.ts'))
    write(repo, 'src/fresh.ts', body('fresh'))
    write(repo, 'src/kept.ts', body('kept') + 'export const extra = 1\n')
  })

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true })
  })

  it('pairs the same renames as git diff -M50%, with similar scores', async () => {
    const service = createGitService()
    await service.open(nodeDirectoryHandle(repo))
    const changes = await service.changes(base)
    const { changes: paired, limited } = await service.detectRenames(changes)
    expect(limited).toBe(false)

    const expected = gitRenames(repo, base)
    expect(expected.size).toBe(2)
    const actual = new Map(paired.filter((change) => change.oldPath).map((change) => [change.path, change]))
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort())
    for (const [path, { from, score }] of expected) {
      const change = actual.get(path)!
      expect(change.oldPath).toBe(from)
      expect(Math.abs(change.similarity! - score)).toBeLessThanOrEqual(5)
    }
    expect(paired.find((change) => change.path === 'src/rewritten.ts')?.status).toBe('deleted')
    expect(paired.find((change) => change.path === 'src/fresh.ts')?.status).toBe('added')

    // The renamed file diffs old against new content.
    const contents = await service.contents(actual.get('src/renamed.ts')!)
    expect(contents.old?.kind).toBe('text')
    expect(contents.new?.kind).toBe('text')
    const analysis = await service.analyze(paired)
    expect(analysis.stats['src/renamed.ts']).toEqual({ additions: 8, deletions: 8 })
    expect(analysis.stats['lib/exact.ts']).toEqual({ additions: 0, deletions: 0 })
  })

  it('reads blob oids at a commit for CI annotation checks', async () => {
    const service = createGitService()
    await service.open(nodeDirectoryHandle(repo))
    const head = git(repo, 'rev-parse', 'HEAD')
    const oids = await service.oidsAt(head, ['lib/exact.ts', 'src/renamed.ts'])
    expect(oids['lib/exact.ts']).toBe(git(repo, 'rev-parse', 'HEAD:lib/exact.ts'))
    expect(oids['src/renamed.ts']).toBeNull()
  })
})
