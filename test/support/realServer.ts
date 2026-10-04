import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const ADMIN_PASSPHRASE = 'integration admin passphrase'

const bunPath = () => {
  const local = join(homedir(), '.bun/bin/bun')
  return process.env.BUN_PATH ?? (existsSync(local) ? local : 'bun')
}

/** Starts server/index.ts with the fake GitHub, a temp data dir and a random port; call `stop` when done. */
export async function startServer() {
  const port = 18000 + Math.floor(Math.random() * 1000)
  const base = `http://127.0.0.1:${port}`
  const dataDir = mkdtempSync(join(tmpdir(), 'codeducky-int-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    WEB_DIST: join(dataDir, 'no-dist'),
    CODEDUCKY_GITHUB_FAKE: '1',
    CODEDUCKY_ADMIN_PASSPHRASE: ADMIN_PASSPHRASE,
    CODEDUCKY_PUBLIC_URL: base,
  }
  delete env.CODEDUCKY_PASSPHRASE
  const server: ChildProcess = spawn(bunPath(), [resolve('server/index.ts')], { env, stdio: 'ignore' })
  const stop = () => {
    server.kill('SIGTERM')
    rmSync(dataDir, { recursive: true, force: true })
  }
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { base, stop }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  stop()
  throw new Error('server did not start')
}
