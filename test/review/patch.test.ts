import { describe, expect, it } from 'vitest'
import { createAnchor } from '../../src/review/anchor'
import { numberLines } from '../../src/review/lines'
import { matchAnchor } from '../../src/review/match'
import { patchSideLines } from '../../src/review/patch'

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
