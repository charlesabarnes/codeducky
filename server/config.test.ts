import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { DEV_ADMIN_PASSPHRASE, loadConfig } from './config'
import { DEFAULT_RATE_LIMITS } from './limits'
import { DEFAULT_QUOTAS } from './records/quota'

const PROD = {
  NODE_ENV: 'production',
  CODEDUCKY_GITHUB_CLIENT_ID: 'Iv1.abc',
  CODEDUCKY_GITHUB_CLIENT_SECRET: 'secret',
  CODEDUCKY_PUBLIC_URL: 'https://ducky.example/',
}

let warn: ReturnType<typeof spyOn>
beforeEach(() => {
  warn = spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => warn.mockRestore())

describe('config', () => {
  it('loads a production config', () => {
    const config = loadConfig({ ...PROD, CODEDUCKY_ADMIN_PASSPHRASE: 'long random' })
    expect(config).toMatchObject({
      production: true,
      github: { clientId: 'Iv1.abc', clientSecret: 'secret' },
      adminPassphrase: 'long random',
      publicUrl: 'https://ducky.example',
      signups: { open: true, maxUsers: null },
      limits: DEFAULT_RATE_LIMITS,
      quotas: DEFAULT_QUOTAS,
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('requires the GitHub secrets and the public URL in production', () => {
    expect(() => loadConfig({ ...PROD, CODEDUCKY_GITHUB_CLIENT_SECRET: undefined })).toThrow('CODEDUCKY_GITHUB_CLIENT_SECRET')
    expect(() => loadConfig({ ...PROD, CODEDUCKY_GITHUB_CLIENT_ID: '' })).toThrow('CODEDUCKY_GITHUB_CLIENT_ID')
    expect(() => loadConfig({ ...PROD, CODEDUCKY_PUBLIC_URL: undefined })).toThrow('CODEDUCKY_PUBLIC_URL must be set')
    expect(() => loadConfig({ ...PROD, CODEDUCKY_PUBLIC_URL: 'ducky.example' })).toThrow('absolute URL')
    expect(() => loadConfig({ ...PROD, CODEDUCKY_PUBLIC_URL: 'ftp://ducky.example' })).toThrow('http or https')
  })

  it('leaves admin sign-in off in production without a passphrase', () => {
    expect(loadConfig(PROD).adminPassphrase).toBeUndefined()
  })

  it('refuses the fake GitHub in production unless explicitly insecure', () => {
    expect(() => loadConfig({ ...PROD, CODEDUCKY_GITHUB_FAKE: '1' })).toThrow('CODEDUCKY_INSECURE_FAKE_GITHUB')
    expect(loadConfig({ ...PROD, CODEDUCKY_GITHUB_FAKE: '1', CODEDUCKY_INSECURE_FAKE_GITHUB: '1' }).github).toBe('fake')
    expect(warn.mock.calls.flat().join(' ')).toContain('Anyone can sign in as anyone')
  })

  it('defaults to the fake GitHub and the dev admin passphrase in development', () => {
    const config = loadConfig({})
    expect(config).toMatchObject({ production: false, github: 'fake', adminPassphrase: DEV_ADMIN_PASSPHRASE, publicUrl: undefined })
    expect(loadConfig({ CODEDUCKY_GITHUB_CLIENT_ID: 'id', CODEDUCKY_GITHUB_CLIENT_SECRET: 's' }).github).toEqual({ clientId: 'id', clientSecret: 's' })
    expect(loadConfig({ CODEDUCKY_GITHUB_CLIENT_ID: 'id', CODEDUCKY_GITHUB_CLIENT_SECRET: 's', CODEDUCKY_GITHUB_FAKE: '1' }).github).toBe('fake')
  })

  it('errors on the old passphrase variable with the new name', () => {
    expect(() => loadConfig({ CODEDUCKY_PASSPHRASE: 'old' })).toThrow('renamed to CODEDUCKY_ADMIN_PASSPHRASE')
    expect(() => loadConfig({ ...PROD, CODEDUCKY_PASSPHRASE: 'old' })).toThrow('renamed to CODEDUCKY_ADMIN_PASSPHRASE')
  })

  it('reads signups, the user cap and quotas', () => {
    const config = loadConfig({ CODEDUCKY_SIGNUPS: 'closed', CODEDUCKY_MAX_USERS: '50', CODEDUCKY_QUOTA_RECORDS: '100', CODEDUCKY_QUOTA_BYTES: '2048' })
    expect(config.signups).toMatchObject({ open: false, maxUsers: 50 })
    expect(config.quotas).toEqual({ records: 100, bytes: 2048 })
    expect(() => loadConfig({ CODEDUCKY_SIGNUPS: 'maybe' })).toThrow('CODEDUCKY_SIGNUPS')
    expect(() => loadConfig({ CODEDUCKY_MAX_USERS: '0' })).toThrow('CODEDUCKY_MAX_USERS')
    expect(() => loadConfig({ CODEDUCKY_QUOTA_BYTES: '1.5' })).toThrow('CODEDUCKY_QUOTA_BYTES')
  })
})
