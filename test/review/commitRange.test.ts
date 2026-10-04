import { describe, expect, it } from 'vitest'
import type { BranchCommit } from '../../src/git/types'
import { describeRange, extendRange, rangeEnds, rangeOf, stepCommit } from '../../src/review/commitRange'

const commit = (sha: string, parents: string[], message: string): BranchCommit => ({ sha, parents, message, author: 'A', date: 0 })
const commits = [
  commit('a'.repeat(40), ['base'], 'First\n\nbody'),
  commit('b'.repeat(40), ['a'.repeat(40), 'm'.repeat(40)], 'Merge main'),
  commit('c'.repeat(40), ['b'.repeat(40)], 'Third'),
]

describe('commit ranges', () => {
  it('steps from All changes through each commit and back', () => {
    expect(stepCommit(null, 3, 1)).toEqual({ from: 0, to: 0 })
    expect(stepCommit(null, 3, -1)).toEqual({ from: 2, to: 2 })
    expect(stepCommit({ from: 0, to: 0 }, 3, 1)).toEqual({ from: 1, to: 1 })
    expect(stepCommit({ from: 2, to: 2 }, 3, 1)).toBeNull()
    expect(stepCommit({ from: 0, to: 0 }, 3, -1)).toBeNull()
    expect(stepCommit({ from: 0, to: 1 }, 3, 1)).toEqual({ from: 2, to: 2 })
    expect(stepCommit(null, 0, 1)).toBeNull()
  })

  it('extends a pick into a contiguous range either way', () => {
    expect(extendRange(null, 1)).toEqual({ from: 1, to: 1 })
    expect(extendRange({ from: 1, to: 1 }, 2)).toEqual({ from: 1, to: 2 })
    expect(extendRange({ from: 1, to: 2 }, 0)).toEqual({ from: 0, to: 2 })
  })

  it('diffs a range from the first commit’s first parent to the last commit', () => {
    expect(rangeEnds(commits, { from: 1, to: 1 })).toEqual({ base: 'a'.repeat(40), head: 'b'.repeat(40) })
    expect(rangeEnds(commits, { from: 0, to: 2 })).toEqual({ base: 'base', head: 'c'.repeat(40) })
    expect(rangeEnds([commit('r'.repeat(40), [], 'root')], { from: 0, to: 0 }).base).toBeNull()
    expect(() => rangeEnds(commits, { from: 4, to: 4 })).toThrow()
  })

  it('describes and finds ranges by sha', () => {
    expect(describeRange(commits, { from: 0, to: 0 })).toBe('aaaaaaa First')
    expect(describeRange(commits, { from: 0, to: 2 })).toBe('3 commits, aaaaaaa..ccccccc')
    expect(rangeOf(commits, 'b'.repeat(40), 'c'.repeat(40))).toEqual({ from: 1, to: 2 })
    expect(rangeOf(commits, 'c'.repeat(40), 'a'.repeat(40))).toBeNull()
    expect(rangeOf(commits, 'x', 'c'.repeat(40))).toBeNull()
  })
})
