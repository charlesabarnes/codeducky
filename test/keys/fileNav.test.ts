import { describe, expect, it } from 'vitest'
import { filterFiles, nextUnviewed, stepFile } from '../../src/features/session/fileNav'

const paths = ['README.md', 'src/config.ts', 'src/webhooks/dispatch.ts', 'test/dispatch.test.ts']

describe('filterFiles', () => {
  const files = paths.map((path) => ({ path }))
  it('matches every term, case-insensitively', () => {
    expect(filterFiles(files, 'DISPATCH').map((f) => f.path)).toEqual(['src/webhooks/dispatch.ts', 'test/dispatch.test.ts'])
    expect(filterFiles(files, 'src dispatch').map((f) => f.path)).toEqual(['src/webhooks/dispatch.ts'])
    expect(filterFiles(files, '  ')).toHaveLength(4)
  })
})

describe('stepFile', () => {
  it('moves in list order without wrapping', () => {
    expect(stepFile(paths, 'README.md', 1)).toBe('src/config.ts')
    expect(stepFile(paths, 'README.md', -1)).toBeNull()
    expect(stepFile(paths, 'test/dispatch.test.ts', 1)).toBeNull()
  })

  it('skips files the predicate rejects', () => {
    const viewed = new Set(['src/config.ts'])
    expect(stepFile(paths, 'README.md', 1, (p) => viewed.has(p))).toBe('src/webhooks/dispatch.ts')
  })

  it('starts from the ends when the current file is filtered out', () => {
    expect(stepFile(paths, 'gone.ts', 1)).toBe('README.md')
    expect(stepFile(paths, null, -1)).toBe('test/dispatch.test.ts')
  })
})

describe('nextUnviewed', () => {
  it('wraps around and never returns the current file', () => {
    const viewed = new Set(['src/webhooks/dispatch.ts', 'test/dispatch.test.ts'])
    expect(nextUnviewed(paths, 'src/config.ts', viewed)).toBe('README.md')
    expect(nextUnviewed(paths, 'README.md', new Set(paths.slice(1)))).toBeNull()
  })
})
