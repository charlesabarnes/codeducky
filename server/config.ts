import { resolve } from 'node:path'

export const DEV_PASSPHRASE = 'codeducky'

export interface Config {
  port: number
  dbPath: string
  webDist: string
  production: boolean
  passphrase: string
  publicUrl?: string
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const production = env.NODE_ENV === 'production'
  let passphrase = env.CODEDUCKY_PASSPHRASE
  if (!passphrase) {
    if (production) throw new Error('CODEDUCKY_PASSPHRASE must be set in production')
    console.warn(`CODEDUCKY_PASSPHRASE is unset; using the dev passphrase "${DEV_PASSPHRASE}"`)
    passphrase = DEV_PASSPHRASE
  }
  const dataDir = resolve(env.DATA_DIR ?? resolve(import.meta.dirname, '../data'))
  return {
    port: Number(env.PORT ?? 8787),
    dbPath: resolve(env.CODEDUCKY_DB ?? resolve(dataDir, 'codeducky.db')),
    webDist: resolve(env.WEB_DIST ?? resolve(import.meta.dirname, '../dist')),
    production,
    passphrase,
    publicUrl: env.CODEDUCKY_PUBLIC_URL || undefined,
  }
}
