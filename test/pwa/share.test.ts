import { describe, expect, it } from 'vitest'
import { readGitHubLink, sharedLink } from '../../src/pwa/share'

const share = (fields: Record<string, string>) => sharedLink(new URLSearchParams(fields))
const pr = (owner: string, name: string, number: number) => ({ kind: 'pr', pull: { owner, name, number } })

describe('sharedLink', () => {
  it('finds a pull request URL in url, text or title', () => {
    expect(share({ url: 'https://github.com/charlesabarnes/codeducky/pull/42' })).toEqual(pr('charlesabarnes', 'codeducky', 42))
    expect(share({ text: 'Can you look at https://github.com/o/r/pull/7/files please?' })).toEqual(pr('o', 'r', 7))
    expect(share({ title: 'Fix it · github.com/o/r/pull/8.' })).toEqual(pr('o', 'r', 8))
  })

  it('prefers url, then text, then title', () => {
    expect(share({ title: 'https://github.com/o/r/pull/1', text: 'https://github.com/o/r/pull/2', url: 'https://github.com/o/r/pull/3' })).toEqual(pr('o', 'r', 3))
    expect(share({ title: 'https://github.com/o/r/pull/1', text: 'see https://github.com/o/r/pull/2' })).toEqual(pr('o', 'r', 2))
  })

  it('skips other GitHub links to find a pull request later in the text', () => {
    expect(share({ text: 'https://github.com/o/r/issues/5 is fixed by https://github.com/o/r/pull/6' })).toEqual(pr('o', 'r', 6))
  })

  it('reads compare URLs, with and without a base, and with a fork head', () => {
    expect(share({ url: 'https://github.com/o/r/compare/main...feature/x?expand=1' })).toEqual({
      kind: 'compare',
      compare: { owner: 'o', name: 'r', base: 'main', head: 'feature/x', headOwner: null, url: 'https://github.com/o/r/compare/main...feature/x' },
    })
    expect(readGitHubLink('github.com/o/r/compare/topic')).toMatchObject({ compare: { base: null, head: 'topic' } })
    expect(readGitHubLink('https://github.com/o/r/compare/main...friend:r:topic')).toMatchObject({ compare: { head: 'topic', headOwner: 'friend' } })
    expect(readGitHubLink('https://github.com/o/r/compare/main...o:topic')).toMatchObject({ compare: { head: 'topic', headOwner: null } })
    expect(readGitHubLink('https://github.com/o/r/compare/main..dev')).toMatchObject({ compare: { base: 'main', head: 'dev' } })
  })

  it('ignores other hosts, other GitHub pages and empty shares', () => {
    expect(share({ url: 'https://gitlab.com/o/r/pull/1' })).toBeNull()
    expect(share({ text: 'https://example.com/?u=github.com' })).toBeNull()
    expect(share({ url: 'https://github.com/o/r' })).toBeNull()
    expect(share({ url: 'https://github.com/o/r/compare/' })).toBeNull()
    expect(share({ text: 'a recipe for pancakes' })).toBeNull()
    expect(share({})).toBeNull()
  })
})
