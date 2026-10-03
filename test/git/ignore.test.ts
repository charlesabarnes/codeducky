import { describe, expect, it } from 'vitest'
import { IgnoreRules } from '../../src/git/ignore'

const rules = (files: Record<string, string>) => new IgnoreRules(async (path) => files[path] ?? null)

describe('IgnoreRules', () => {
  it('applies root, nested and info/exclude rules', async () => {
    const ignore = rules({
      '.gitignore': 'node_modules/\n*.log\n',
      'pkg/.gitignore': '!keep.log\ndist\n',
      '.git/info/exclude': 'scratch.txt\n',
    })
    expect(await ignore.isIgnored('node_modules', true)).toBe(true)
    expect(await ignore.isIgnored('node_modules', false)).toBe(false)
    expect(await ignore.isIgnored('debug.log', false)).toBe(true)
    expect(await ignore.isIgnored('pkg/keep.log', false)).toBe(false)
    expect(await ignore.isIgnored('pkg/other.log', false)).toBe(true)
    expect(await ignore.isIgnored('pkg/dist', true)).toBe(true)
    expect(await ignore.isIgnored('dist', true)).toBe(false)
    expect(await ignore.isIgnored('scratch.txt', false)).toBe(true)
    expect(await ignore.isIgnored('src/index.ts', false)).toBe(false)
  })

  it('reads each ignore file once', async () => {
    const reads: string[] = []
    const ignore = new IgnoreRules(async (path) => {
      reads.push(path)
      return null
    })
    await ignore.isIgnored('a/b/c.ts', false)
    await ignore.isIgnored('a/b/d.ts', false)
    expect(reads.sort()).toEqual(['.git/info/exclude', '.gitignore', 'a/.gitignore', 'a/b/.gitignore'])
  })
})
