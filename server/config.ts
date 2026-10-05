import { createECDH } from 'node:crypto'
import { resolve } from 'node:path'
import { loadRateLimits, positiveInt, type RateLimits } from './limits'
import type { VapidKeys } from './push/webPush'
import { loadQuotas, type Quotas } from './records/quota'

export const DEV_ADMIN_PASSPHRASE = 'codeducky'

/** New accounts per hour are limited separately (CODEDUCKY_RATE_NEW_ACCOUNTS). */
export interface SignupPolicy {
  open: boolean
  /** Cap on GitHub accounts; null for no cap. */
  maxUsers: number | null
}

export const DEFAULT_SIGNUPS: SignupPolicy = { open: true, maxUsers: null }

export type GitHubConfig = { clientId: string; clientSecret: string } | 'fake'

export interface Config {
  port: number
  dbPath: string
  webDist: string
  production: boolean
  github: GitHubConfig
  /** Unset disables admin sign-in. */
  adminPassphrase?: string
  publicUrl?: string
  signups: SignupPolicy
  limits: RateLimits
  quotas: Quotas
  /** Unset disables Web Push. */
  vapid?: VapidKeys
}

type Env = Record<string, string | undefined>

function githubConfig(env: Env, production: boolean): GitHubConfig {
  const clientId = env.CODEDUCKY_GITHUB_CLIENT_ID || undefined
  const clientSecret = env.CODEDUCKY_GITHUB_CLIENT_SECRET || undefined
  const fake = env.CODEDUCKY_GITHUB_FAKE === '1' || (!production && !clientId)
  if (fake) {
    if (production && env.CODEDUCKY_INSECURE_FAKE_GITHUB !== '1') {
      throw new Error('CODEDUCKY_GITHUB_FAKE lets anyone sign in as anyone; in production it also needs CODEDUCKY_INSECURE_FAKE_GITHUB=1')
    }
    console.warn(
      production
        ? 'WARNING: fake GitHub sign-in is on in production (CODEDUCKY_INSECURE_FAKE_GITHUB=1). Anyone can sign in as anyone.'
        : 'Using fake GitHub sign-in; set CODEDUCKY_GITHUB_CLIENT_ID and CODEDUCKY_GITHUB_CLIENT_SECRET for the real one',
    )
    return 'fake'
  }
  if (!clientId || !clientSecret) throw new Error('CODEDUCKY_GITHUB_CLIENT_ID and CODEDUCKY_GITHUB_CLIENT_SECRET must both be set')
  return { clientId, clientSecret }
}

function publicUrl(env: Env, production: boolean): string | undefined {
  const value = env.CODEDUCKY_PUBLIC_URL || undefined
  if (!value) {
    if (production) throw new Error('CODEDUCKY_PUBLIC_URL must be set in production, e.g. https://codeducky.example.com')
    return undefined
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('CODEDUCKY_PUBLIC_URL must be an absolute URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('CODEDUCKY_PUBLIC_URL must be an http or https URL')
  return url.origin
}

function adminPassphrase(env: Env, production: boolean): string | undefined {
  const value = env.CODEDUCKY_ADMIN_PASSPHRASE || undefined
  if (value || production) return value
  console.warn(`CODEDUCKY_ADMIN_PASSPHRASE is unset; using the dev passphrase "${DEV_ADMIN_PASSPHRASE}"`)
  return DEV_ADMIN_PASSPHRASE
}

/** The public key the private key derives, or null when the private key is not a P-256 scalar. */
function derivedPublicKey(privateKey: string): string | null {
  try {
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'))
    return ecdh.getPublicKey('base64url')
  } catch {
    return null
  }
}

function vapid(env: Env): VapidKeys | undefined {
  const publicKey = env.CODEDUCKY_VAPID_PUBLIC_KEY?.trim() || undefined
  const privateKey = env.CODEDUCKY_VAPID_PRIVATE_KEY?.trim() || undefined
  const subject = env.CODEDUCKY_VAPID_SUBJECT?.trim() || undefined
  if (!publicKey && !privateKey && !subject) return undefined
  if (!publicKey || !privateKey || !subject) {
    throw new Error('Web Push needs CODEDUCKY_VAPID_PUBLIC_KEY, CODEDUCKY_VAPID_PRIVATE_KEY and CODEDUCKY_VAPID_SUBJECT together; run npm run vapid')
  }
  if (derivedPublicKey(privateKey) !== publicKey) {
    throw new Error('CODEDUCKY_VAPID_PRIVATE_KEY does not belong to CODEDUCKY_VAPID_PUBLIC_KEY; set both from one npm run vapid')
  }
  if (!/^mailto:[^@\s]+@[^@\s]+$/.test(subject) && !/^https:\/\/[^\s]+$/.test(subject)) {
    throw new Error('CODEDUCKY_VAPID_SUBJECT must be a mailto: address or an https: URL')
  }
  return { publicKey, privateKey, subject }
}

function signups(env: Env): SignupPolicy {
  const mode = env.CODEDUCKY_SIGNUPS || 'open'
  if (mode !== 'open' && mode !== 'closed') throw new Error('CODEDUCKY_SIGNUPS must be "open" or "closed"')
  return { open: mode === 'open', maxUsers: positiveInt(env, 'CODEDUCKY_MAX_USERS') ?? null }
}

export function loadConfig(env: Env = process.env): Config {
  if (env.CODEDUCKY_PASSPHRASE) throw new Error('CODEDUCKY_PASSPHRASE was renamed to CODEDUCKY_ADMIN_PASSPHRASE; set that instead')
  const production = env.NODE_ENV === 'production'
  const dataDir = resolve(env.DATA_DIR ?? resolve(import.meta.dirname, '../data'))
  return {
    port: Number(env.PORT ?? 8787),
    dbPath: resolve(env.CODEDUCKY_DB ?? resolve(dataDir, 'codeducky.db')),
    webDist: resolve(env.WEB_DIST ?? resolve(import.meta.dirname, '../dist')),
    production,
    github: githubConfig(env, production),
    adminPassphrase: adminPassphrase(env, production),
    publicUrl: publicUrl(env, production),
    signups: signups(env),
    limits: loadRateLimits(env),
    quotas: loadQuotas(env),
    vapid: vapid(env),
  }
}
