import { describe, expect, it } from 'vitest'
import type { FileChange } from '../../src/git/types'
import { MAX_SUMMARY_FILES, sameSummary, summarizeFiles } from '../../src/review/fileSummary'
import { validateChange } from '../../shared/sync'

const change = (path: string, status: FileChange['status'] = 'modified'): FileChange => ({ path, status, oldOid: null, newOid: null })

describe('session file summary', () => {
  it('records status and line counts, and marks binary files', () => {
    const summary = summarizeFiles([change('a.ts'), change('b.png', 'added'), change('c.ts', 'deleted')], {
      'a.ts': { additions: 3, deletions: 1 },
      'b.png': { binary: true },
    })
    expect(summary).toEqual([
      { path: 'a.ts', status: 'modified', additions: 3, deletions: 1 },
      { path: 'b.png', status: 'added', binary: true },
      { path: 'c.ts', status: 'deleted' },
    ])
  })

  it('caps the list and compares by content', () => {
    const many = Array.from({ length: MAX_SUMMARY_FILES + 5 }, (_, i) => change(`f${i}.ts`))
    expect(summarizeFiles(many, {})).toHaveLength(MAX_SUMMARY_FILES)
    const one = summarizeFiles([change('a.ts')], { 'a.ts': { additions: 1, deletions: 0 } })
    expect(sameSummary(undefined, one)).toBe(false)
    expect(sameSummary([{ ...one[0]! }], one)).toBe(true)
    expect(sameSummary([{ ...one[0]!, additions: 2 }], one)).toBe(false)
  })

  it('passes sync validation on a session record', () => {
    const data = { repoId: 'r', branch: 'b', headSha: 'h', baseSha: 'b', baseSource: 'local', startedAt: 1, status: 'active' }
    const files = summarizeFiles([change('a.ts')], { 'a.ts': { additions: 1, deletions: 0 } })
    expect(validateChange({ kind: 'sessions', id: 's', changedAt: 1, deleted: false, data: { ...data, files } })).toBeNull()
    expect(validateChange({ kind: 'sessions', id: 's', changedAt: 1, deleted: false, data: { ...data, files: [{ path: 1 }] } })).toBe(
      'sessions.files is invalid',
    )
  })
})
