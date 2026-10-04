import { describe, expect, it } from 'vitest'
import { adminSignInErrorMessage, parseSignInFragment, signInErrorMessage } from '../../src/features/sync/signInErrors'
import { formatBytes, usageLine, usageShare } from '../../src/features/sync/usage'

describe('sign-in callback fragment', () => {
  it('reads the hand-off code or the error', () => {
    expect(parseSignInFragment('#handoff=abc_123')).toEqual({ handoff: 'abc_123' })
    expect(parseSignInFragment('#error=signups_closed')).toEqual({ error: 'signups_closed' })
    expect(parseSignInFragment('')).toBeNull()
    expect(parseSignInFragment('#handoff=')).toBeNull()
  })

  it('explains every error the callback can report, and falls back for unknown ones', () => {
    const generic = signInErrorMessage('error')
    for (const code of ['access_denied', 'invalid_state', 'signups_closed', 'account_disabled', 'github_error', 'rate_limited']) {
      expect(signInErrorMessage(code), code).not.toBe(generic)
    }
    expect(signInErrorMessage('something_new')).toBe(generic)
    expect(adminSignInErrorMessage('invalid')).toBe('Wrong passphrase.')
    expect(adminSignInErrorMessage('offline')).toBe(signInErrorMessage('offline'))
  })
})

describe('usage', () => {
  it('formats sizes and the usage line', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB')
    expect(usageLine({ bytes: 1.2 * 1024 * 1024, records: 3100 }, { bytes: 50 * 1024 * 1024, records: 20_000 })).toBe(
      '1.2 MB of 50 MB · 3,100 of 20,000 records',
    )
  })

  it('reports the fuller limit', () => {
    expect(usageShare({ bytes: 10, records: 15 }, { bytes: 100, records: 20 })).toBe(0.75)
    expect(usageShare({ bytes: 500, records: 0 }, { bytes: 100, records: 20 })).toBe(1)
  })
})
