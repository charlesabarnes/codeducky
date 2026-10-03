import { describe, expect, it } from 'vitest'
import type { FileChange } from '../../src/git/types'
import { comparePaths, folderOrder, isLockfile, pairTests, riskOf, riskOrder, testSubject } from '../../src/review/order'

const change = (path: string, status: FileChange['status'] = 'modified'): FileChange => ({ path, status, oldOid: 'a', newOid: 'b' })
const paths = (files: { path: string }[]) => files.map((file) => file.path)

describe('testSubject', () => {
  it.each([
    ['src/diff/hunks.test.ts', 'hunks'],
    ['src/app/Layout.spec.tsx', 'layout'],
    ['src/__tests__/format.ts', 'format'],
    ['test/diff/hunks.test.ts', 'hunks'],
    ['app/src/test/java/com/acme/InvoiceServiceTest.java', 'invoiceservice'],
    ['app/src/test/kotlin/com/acme/LedgerTests.kt', 'ledger'],
    ['pkg/store/store_test.go', 'store'],
    ['tests/test_parser.py', 'parser'],
  ])('%s tests %s', (path, subject) => {
    expect(testSubject(path)).toBe(subject)
  })

  it.each(['src/diff/hunks.ts', 'src/Contest.java', 'docs/testing.md'])('%s is not a test', (path) => {
    expect(testSubject(path)).toBeNull()
  })
})

describe('pairTests', () => {
  it('matches mirrored test folders to the closest source', () => {
    const pairs = pairTests([
      'src/diff/hunks.ts',
      'src/review/hunks.ts',
      'test/diff/hunks.test.ts',
      'app/src/main/java/com/acme/InvoiceService.java',
      'app/src/test/java/com/acme/InvoiceServiceTest.java',
      'test/orphan.test.ts',
    ])
    expect(pairs.get('test/diff/hunks.test.ts')).toBe('src/diff/hunks.ts')
    expect(pairs.get('app/src/test/java/com/acme/InvoiceServiceTest.java')).toBe('app/src/main/java/com/acme/InvoiceService.java')
    expect(pairs.has('test/orphan.test.ts')).toBe(false)
  })
})

describe('folderOrder', () => {
  it('sorts by folder, folders first, with tests right after their source', () => {
    const files = [
      'README.md',
      'src/b.ts',
      'src/a.ts',
      'src/a.test.ts',
      'src/lib/util.ts',
      'test/b.test.ts',
      'test/lonely.test.ts',
      'src/__tests__/util.test.ts',
    ].map((path) => change(path))
    expect(paths(folderOrder(files))).toEqual([
      'src/lib/util.ts',
      'src/__tests__/util.test.ts',
      'src/a.ts',
      'src/a.test.ts',
      'src/b.ts',
      'test/b.test.ts',
      'test/lonely.test.ts',
      'README.md',
    ])
  })

  it('compares paths segment by segment', () => {
    expect(comparePaths('a/b.ts', 'a-b/c.ts')).toBeLessThan(0)
    expect(comparePaths('a/z/x.ts', 'a/b.ts')).toBeLessThan(0)
  })
})

describe('risk', () => {
  it('scores sensitive paths, new files, deleted tests and open notes', () => {
    expect(riskOf(change('src/auth/session.ts'), {}).reasons).toContain('sensitive path')
    expect(riskOf(change('db/migrations/0042_add_index.sql'), {}).reasons).toContain('sensitive path')
    expect(riskOf(change('vite.config.ts'), {}).reasons).toContain('configuration')
    expect(riskOf(change('src/new.ts', 'added'), {}).reasons).toContain('new file')
    expect(riskOf(change('src/a.test.ts', 'deleted'), {}).reasons).toContain('deleted test')
    expect(riskOf(change('src/a.ts'), { openNotes: 2 }).reasons).toContain('2 open notes')
  })

  it('puts lockfiles last and keeps folder order for ties', () => {
    const stats = { additions: 3, deletions: 1 }
    const files = [change('package-lock.json'), change('src/z.ts'), change('src/a.ts'), change('src/auth/login.ts'), change('src/big.ts')]
    const order = riskOrder(files, (file) => ({ stats: file.path === 'src/big.ts' ? { additions: 40, deletions: 10 } : stats }))
    expect(paths(order)).toEqual(['src/auth/login.ts', 'src/big.ts', 'src/a.ts', 'src/z.ts', 'package-lock.json'])
    expect(isLockfile('web/pnpm-lock.yaml')).toBe(true)
  })
})
