import { spawnSync } from 'node:child_process'

export interface ChannelConfig {
  url: string
  token: string
}

export type ConfigResult = { ok: true; config: ChannelConfig } | { ok: false; error: string }

export interface ConfigSources {
  env: Record<string, string | undefined>
  /** `git config --get rubberduck.url`, which the pre-push gate also reads. */
  gitUrl: () => string | null
  /** The macOS Keychain item "rubberduck", which the pre-push gate also reads. */
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
  gitUrl: () => output('git', ['config', '--get', 'rubberduck.url'], cwd),
  keychainToken: () => (process.platform === 'darwin' ? output('security', ['find-generic-password', '-s', 'rubberduck', '-w']) : null),
})

/** RUBBERDUCK_URL, else git config rubberduck.url; RUBBERDUCK_TOKEN, else the Keychain. */
export function resolveConfig(sources: ConfigSources): ConfigResult {
  const rawUrl = sources.env.RUBBERDUCK_URL?.trim() || sources.gitUrl()
  if (!rawUrl) return { ok: false, error: 'No Rubberduck URL: set RUBBERDUCK_URL or `git config --global rubberduck.url <url>`.' }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, error: `RUBBERDUCK_URL is not a URL: ${rawUrl}` }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: `RUBBERDUCK_URL must be http(s): ${rawUrl}` }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol === 'http:' && !local) return { ok: false, error: 'RUBBERDUCK_URL must use https unless it points at localhost.' }
  const token = sources.env.RUBBERDUCK_TOKEN?.trim() || sources.keychainToken()
  if (!token) return { ok: false, error: 'No Rubberduck token: set RUBBERDUCK_TOKEN or store one in the Keychain item "rubberduck".' }
  return { ok: true, config: { url: url.origin + url.pathname.replace(/\/+$/, ''), token } }
}
