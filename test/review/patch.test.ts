import { describe, expect, it } from 'vitest'
import { createAnchor } from '../../src/review/anchor'
import { numberLines } from '../../src/review/lines'
import { matchAnchor } from '../../src/review/match'
import { patchDiffLines, patchSideLines } from '../../src/review/patch'

const patch = [
  '@@ -1,4 +1,5 @@',
  ' one',
  '-two',
  '+TWO',
  '+two and a half',
  ' three',
  ' four',
  '@@ -20,2 +21,3 @@ function x() {',
  ' twenty',
  '+added',
  ' twenty-one',
  '\\ No newline at end of file',
].join('\n')

describe('patchSideLines', () => {
  it('numbers the RIGHT side', () => {
    expect(patchSideLines(patch, 'RIGHT')).toEqual([
      { line: 1, text: 'one' },
      { line: 2, text: 'TWO' },
      { line: 3, text: 'two and a half' },
      { line: 4, text: 'three' },
      { line: 5, text: 'four' },
      { line: 21, text: 'twenty' },
      { line: 22, text: 'added' },
      { line: 23, text: 'twenty-one' },
    ])
  })

  it('numbers the LEFT side', () => {
    expect(patchSideLines(patch, 'LEFT').map((entry) => entry.line)).toEqual([1, 2, 3, 4, 20, 21])
  })

  it('lets a working-tree anchor map onto the patch', () => {
    const workTree = numberLines(
      ['one', 'TWO', 'two and a half', 'three', 'four', ...Array.from({ length: 15 }, (_, i) => `filler ${i}`), 'twenty', 'added', 'twenty-one'].join('\n'),
    )
    const anchor = createAnchor(workTree, 22, 'new')
    expect(matchAnchor(anchor, patchSideLines(patch, 'RIGHT'))).toMatchObject({ line: 22 })
  })
})

describe('patchDiffLines', () => {
  it('numbers both sides and skips no-newline markers and a trailing blank', () => {
    const lines = patchDiffLines('@@ -3,3 +3,3 @@ fn\n a\n-b\n+B\n\\ No newline at end of file\n c\n')
    expect(lines).toEqual([
      { kind: 'context', text: 'a', oldNo: 3, newNo: 3 },
      { kind: 'del', text: 'b', oldNo: 4, newNo: null },
      { kind: 'add', text: 'B', oldNo: null, newNo: 4 },
      { kind: 'context', text: 'c', oldNo: 5, newNo: 5 },
    ])
  })
})
