import { describe, expect, it } from 'vitest'
import { parseGitHubRemote } from '../../src/git/remote'

describe('parseGitHubRemote', () => {
  it.each([
    'git@github.com:acme/widgets.git',
    'git@github.com:acme/widgets',
    'https://github.com/acme/widgets.git',
    'https://token@github.com/acme/widgets',
    'ssh://git@github.com/acme/widgets.git',
    'https://github.com/acme/widgets/',
  ])('parses %s', (url) => {
    expect(parseGitHubRemote(url)).toEqual({ owner: 'acme', name: 'widgets' })
  })

  it('keeps dots inside repository names', () => {
    expect(parseGitHubRemote('git@github.com:acme/site.github.io.git')).toEqual({ owner: 'acme', name: 'site.github.io' })
  })

  it('rejects non-GitHub remotes', () => {
    expect(parseGitHubRemote('git@gitlab.com:acme/widgets.git')).toBeNull()
    expect(parseGitHubRemote('/tmp/local/repo')).toBeNull()
  })
})
