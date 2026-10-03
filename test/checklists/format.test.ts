import { describe, expect, it } from 'vitest'
import {
  checklistsToJson,
  checklistsToMarkdown,
  parseChecklistFile,
  parseChecklistJson,
  parseChecklistMarkdown,
} from '../../src/checklists/format'

const lists = [
  { title: 'Before push', items: ['Tests pass', 'No console.log'] },
  { title: 'API', items: ['Errors are typed'] },
]

describe('checklist formats', () => {
  it('round-trips JSON', () => {
    expect(parseChecklistJson(checklistsToJson(lists))).toEqual(lists)
  })

  it('writes and reads markdown task lists', () => {
    const markdown = checklistsToMarkdown(lists)
    expect(markdown).toBe('# Before push\n\n- [ ] Tests pass\n- [ ] No console.log\n\n# API\n\n- [ ] Errors are typed\n')
    expect(parseChecklistMarkdown(markdown, 'x')).toEqual(lists)
  })

  it('uses the file name when markdown has no heading and accepts checked or plain bullets', () => {
    expect(parseChecklistFile('release.md', '- [x] Tag\n* Changelog\n\nprose\n')).toEqual([
      { title: 'release', items: ['Tag', 'Changelog'] },
    ])
  })

  it('accepts a bare JSON array', () => {
    expect(parseChecklistFile('a.json', JSON.stringify([{ title: ' T ', items: [' a ', ''] }]))).toEqual([
      { title: 'T', items: ['a'] },
    ])
  })

  it('rejects files without checklists', () => {
    expect(() => parseChecklistJson('{"foo":1}')).toThrow()
    expect(() => parseChecklistMarkdown('# Empty\n', 'x')).toThrow()
  })
})
