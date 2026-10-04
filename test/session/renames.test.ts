import { describe, expect, it } from 'vitest'
import { currentPath, pathParts, renamedPaths } from '../../src/features/session/renames'

describe('pathParts', () => {
  it('splits a path into folders and name', () => {
    expect(pathParts('src/lib/log.ts')).toEqual({ dir: 'src/lib/', name: 'log.ts' })
    expect(pathParts('README.md')).toEqual({ dir: '', name: 'README.md' })
  })

  it.each([
    ['src/lib/logger.ts', 'src/lib/log.ts', 'src/lib/', '{logger.ts → log.ts}'],
    ['src/a/x.ts', 'src/b/x.ts', 'src/', '{a → b}/x.ts'],
    ['old.ts', 'new.ts', '', 'old.ts → new.ts'],
    ['lib/exact.ts', 'src/lib/exact.ts', '', '{lib → src/lib}/exact.ts'],
  ])('renames %s → %s in git\'s short form', (from, to, dir, name) => {
    expect(pathParts(to, from)).toEqual({ dir, name })
  })
})

describe('renamedPaths', () => {
  it('maps old paths to new ones so notes follow a rename', () => {
    const renamed = renamedPaths([
      { path: 'src/log.ts', status: 'modified', oldOid: 'a', newOid: 'b', oldPath: 'src/logger.ts', similarity: 84 },
      { path: 'src/x.ts', status: 'modified', oldOid: 'a', newOid: 'b' },
    ])
    expect(currentPath('src/logger.ts', renamed)).toBe('src/log.ts')
    expect(currentPath('src/x.ts', renamed)).toBe('src/x.ts')
  })
})
