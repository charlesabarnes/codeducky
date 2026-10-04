import { spawnSync } from 'node:child_process'

export interface ChannelConfig {
  url: string
  token: string
}

export type ConfigResult = { ok: true; config: ChannelConfig } | { ok: false; error: string }

export interface ConfigSources {
  env: Record<string, string | undefined>
  /** `git config --get codeducky.url`, which the pre-push gate also reads. */
  gitUrl: () => string | null
  /** The macOS Keychain item "codeducky", which the pre-push gate also reads. */
  keychainToken: () => string | null
}

/** Runs a command and returns its trimmed stdout, or null when it fails or prints nothing. */
export function output(command: string, args: string[], cwd?: string): string | null {
  try {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
    const text = result.status === 0 ? result.stdout.trim() : ''
    return text || null
  } catch {
    return null
  }
}

export const systemSources = (cwd: string): ConfigSources => ({
  env: process.env,
  gitUrl: () => output('git', ['config', '--get', 'codeducky.url'], cwd),
  keychainToken: () => (process.platform === 'darwin' ? output('security', ['find-generic-password', '-s', 'codeducky', '-w']) : null),
})

/** CODEDUCKY_URL, else git config codeducky.url; CODEDUCKY_TOKEN, else the Keychain. */
export function resolveConfig(sources: ConfigSources): ConfigResult {
  const rawUrl = sources.env.CODEDUCKY_URL?.trim() || sources.gitUrl()
  if (!rawUrl) return { ok: false, error: 'No Code Ducky URL: set CODEDUCKY_URL or `git config --global codeducky.url <url>`.' }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, error: `CODEDUCKY_URL is not a URL: ${rawUrl}` }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: `CODEDUCKY_URL must be http(s): ${rawUrl}` }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol === 'http:' && !local) return { ok: false, error: 'CODEDUCKY_URL must use https unless it points at localhost.' }
  const token = sources.env.CODEDUCKY_TOKEN?.trim() || sources.keychainToken()
  if (!token) return { ok: false, error: 'No Code Ducky token: set CODEDUCKY_TOKEN or store one in the Keychain item "codeducky".' }
  return { ok: true, config: { url: url.origin + url.pathname.replace(/\/+$/, ''), token } }
}
