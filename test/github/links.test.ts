import { describe, expect, it } from 'vitest'
import { githubPrUrl, matchPrPath, parsePrReference, prPath, prUrl } from '../../shared/links'

const ref = { owner: 'charlesabarnes', name: 'codeducky', number: 12 }

describe('pull request links', () => {
  it('builds the canonical path and URLs', () => {
    expect(prPath(ref)).toBe('/pr/charlesabarnes/codeducky/12')
    expect(prUrl('https://codeducky.example.com/', ref)).toBe('https://codeducky.example.com/pr/charlesabarnes/codeducky/12')
    expect(githubPrUrl(ref)).toBe('https://github.com/charlesabarnes/codeducky/pull/12')
  })

  it('matches both route shapes', () => {
    expect(matchPrPath('/pr/charlesabarnes/codeducky/12')).toEqual(ref)
    expect(matchPrPath('/pr/charlesabarnes/codeducky/12/')).toEqual(ref)
    expect(matchPrPath('/charlesabarnes/codeducky/pull/12')).toEqual(ref)
    expect(matchPrPath('/charlesabarnes/codeducky/pull/12/files')).toEqual(ref)
    expect(matchPrPath('/charlesabarnes/codeducky/pull/12/commits/0a1b2c')).toEqual(ref)
    expect(matchPrPath('/my.org/repo_name-2/pull/7')).toEqual({ owner: 'my.org', name: 'repo_name-2', number: 7 })
  })

  it('rejects paths that are not pull requests', () => {
    for (const path of ['/charlesabarnes/codeducky', '/charlesabarnes/codeducky/issues/12', '/pr/a/b/c', '/pr/a/b/0', '/a/b/pull/12/blame', '/a%2Fx/b/pull/1']) {
      expect(matchPrPath(path), path).toBeNull()
    }
  })

  it('reads pasted GitHub and Code Ducky URLs', () => {
    expect(parsePrReference('https://github.com/charlesabarnes/codeducky/pull/12')).toEqual(ref)
    expect(parsePrReference('  https://github.com/charlesabarnes/codeducky/pull/12/files#diff-abc  ')).toEqual(ref)
    expect(parsePrReference('github.com/charlesabarnes/codeducky/pull/12?w=1')).toEqual(ref)
    expect(parsePrReference('https://codeducky.example.com/pr/charlesabarnes/codeducky/12')).toEqual(ref)
    expect(parsePrReference('https://codeducky.example.com/charlesabarnes/codeducky/pull/12/files')).toEqual(ref)
  })

  it('reads owner/repo#123, and #123 only with a current repo', () => {
    expect(parsePrReference('charlesabarnes/codeducky#12')).toEqual(ref)
    expect(parsePrReference('#12', { owner: 'charlesabarnes', name: 'codeducky' })).toEqual(ref)
    expect(parsePrReference('12', { owner: 'charlesabarnes', name: 'codeducky' })).toEqual(ref)
    expect(parsePrReference('#12')).toBeNull()
    expect(parsePrReference('#12', null)).toBeNull()
  })

  it('rejects anything else', () => {
    for (const input of ['', '   ', 'codeducky#12', 'https://github.com/charlesabarnes/codeducky/issues/12', 'not a url', 'a/b#0', 'a/b#x']) {
      expect(parsePrReference(input), input).toBeNull()
    }
  })
})
