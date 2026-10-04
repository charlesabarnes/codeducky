import { existsSync } from 'node:fs'
import { createApp } from './app'
import { fakeGitHubProvider } from './auth/fakeGitHub'
import { githubProvider } from './auth/github'
import { loadConfig } from './config'
import { openDatabase } from './db'
import { stdoutSink } from './log'

const config = loadConfig()
const db = openDatabase(config.dbPath)
if (!existsSync(config.webDist)) console.warn(`No built app at ${config.webDist}; serving the API only`)
const { app } = createApp({
  db,
  provider: config.github === 'fake' ? fakeGitHubProvider() : githubProvider({ ...config.github, log: stdoutSink }),
  adminPassphrase: config.adminPassphrase,
  signups: config.signups,
  publicUrl: config.publicUrl,
  limits: config.limits,
  quotas: config.quotas,
  webDist: existsSync(config.webDist) ? config.webDist : undefined,
})

// Channel streams send a heartbeat every 15 seconds; Bun's default idle timeout is 10.
const server = Bun.serve({ port: config.port, fetch: app.fetch, idleTimeout: 60 })
console.log(`codeducky listening on http://localhost:${server.port}`)

const shutdown = () => {
  void server.stop()
  db.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
