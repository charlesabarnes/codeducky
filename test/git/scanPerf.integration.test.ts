import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLines } from '../../src/diff/hunks'
import { createGitService } from '../../src/git/service'
import { createWordDiffer } from '../../src/diff/wordDiff'
import { orderFiles } from '../../src/review/order'
import { nodeDirectoryHandle } from '../support/nodeHandle'

/** A large real change set, read-only: gangway's working tree against HEAD~40 (about 500 files). */
const REPO = process.env.PERF_REPO ?? '/Users/charlesbarnes/Documents/dev/gangway'
const BASE = process.env.PERF_BASE ?? 'HEAD~40'

const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trimEnd()

describe.skipIf(!existsSync(join(REPO, '.git')))('scan performance on a large change set (read-only)', () => {
  it('lists, pairs renames, analyses and orders quickly, matching git renames', async () => {
    const base = git('rev-parse', BASE)
    const service = createGitService()
    await service.open(nodeDirectoryHandle(REPO))
    const time = async <T>(label: string, work: () => Promise<T>): Promise<[T, number]> => {
      const started = performance.now()
      const result = await work()
      const ms = Math.round(performance.now() - started)
      console.info(`${label}: ${ms}ms`)
      return [result, ms]
    }
    const [changes] = await time('changes', () => service.changes(base))
    const [renamed, renameMs] = await time('renames', () => service.detectRenames(changes))
    const [analysis, analyzeMs] = await time('analyze', () => service.analyze(renamed.changes))
    const [, orderMs] = await time('order', async () => orderFiles(renamed.changes, 'folders', () => ({})))
    const movedFiles = Object.keys(analysis.moved).length
    console.info(`${changes.length} files, ${renamed.changes.filter((c) => c.oldPath).length} renames, moved blocks in ${movedFiles} files`)

    // Committed renames that git also finds (git sees no untracked files, so compare those only).
    const gitRenames = git('diff', '-M50%', '--name-status', base, 'HEAD')
      .split('\n')
      .filter((line) => line.startsWith('R'))
      .map((line) => line.split('\t').slice(1).join(' → '))
    const ours = new Set(renamed.changes.filter((c) => c.oldPath).map((c) => `${c.oldPath} → ${c.path}`))
    for (const rename of gitRenames) expect(ours).toContain(rename)

    // Rendering work for the largest file: diff, then word diffs for every changed line.
    const largest = renamed.changes
      .filter((change) => change.status === 'modified')
      .sort((a, b) => {
        const size = (path: string) => {
          const stats = analysis.stats[path]
          return stats && 'additions' in stats ? stats.additions + stats.deletions : 0
        }
        return size(b.path) - size(a.path)
      })[0]!
    const contents = await service.contents(largest)
    const [, renderMs] = await time(`diff + words for ${largest.path}`, async () => {
      const lines = buildLines(contents.old?.kind === 'text' ? contents.old.text : '', contents.new?.kind === 'text' ? contents.new.text : '')
      const words = createWordDiffer(lines)
      for (const line of lines) if (line.kind !== 'context') words(line)
    })

    expect(renameMs).toBeLessThan(5_000)
    expect(analyzeMs).toBeLessThan(20_000)
    expect(orderMs).toBeLessThan(200)
    expect(renderMs).toBeLessThan(1_000)
  })
})
