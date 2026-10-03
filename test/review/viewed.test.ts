import { describe, expect, it } from 'vitest'
import type { FileChange } from '../../src/git/types'
import { contentHash, isViewed, viewedPaths } from '../../src/review/viewed'

const change = (path: string, newOid: string | null): FileChange => ({
  path,
  status: newOid ? 'modified' : 'deleted',
  oldOid: 'base',
  newOid,
})

describe('viewed', () => {
  it('is viewed only while the content hash matches', () => {
    const view = { sessionId: 1, path: 'a', contentHash: contentHash(change('a', 'v1')), viewed: true }
    expect(isViewed(view, contentHash(change('a', 'v1')))).toBe(true)
    expect(isViewed(view, contentHash(change('a', 'v2')))).toBe(false)
    expect(isViewed({ ...view, viewed: false }, view.contentHash)).toBe(false)
    expect(isViewed(undefined, view.contentHash)).toBe(false)
  })

  it('collects viewed paths for the current files', () => {
    const files = [change('a', 'v1'), change('b', 'v2'), change('c', null)]
    const views = [
      { sessionId: 1, path: 'a', contentHash: contentHash(change('a', 'v1')), viewed: true },
      { sessionId: 1, path: 'b', contentHash: contentHash(change('b', 'old')), viewed: true },
      { sessionId: 1, path: 'c', contentHash: contentHash(change('c', null)), viewed: true },
    ]
    expect([...viewedPaths(files, views)]).toEqual(['a', 'c'])
  })
})
