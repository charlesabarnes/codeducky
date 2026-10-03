import { describe, expect, it } from 'vitest'
import { currentPath, renameLabel, renamedPaths } from '../../src/features/session/renames'

describe('renameLabel', () => {
  it.each([
    ['src/lib/logger.ts', 'src/lib/log.ts', 'src/lib/{logger.ts → log.ts}'],
    ['src/a/x.ts', 'src/b/x.ts', 'src/{a → b}/x.ts'],
    ['old.ts', 'new.ts', 'old.ts → new.ts'],
    ['lib/exact.ts', 'src/lib/exact.ts', '{lib → src/lib}/exact.ts'],
  ])('%s → %s', (from, to, label) => {
    expect(renameLabel(from, to)).toBe(label)
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
