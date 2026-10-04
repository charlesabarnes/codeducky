import { existsSync } from 'node:fs'
import { createApp } from './app'
import { loadConfig } from './config'
import { openDatabase } from './db'

const config = loadConfig()
const db = openDatabase(config.dbPath)
if (!existsSync(config.webDist)) console.warn(`No built app at ${config.webDist}; serving the API only`)
const { app } = createApp({
  db,
  passphrase: config.passphrase,
  publicUrl: config.publicUrl,
  webDist: existsSync(config.webDist) ? config.webDist : undefined,
})

// Channel streams send a heartbeat every 15 seconds; Bun's default idle timeout is 10.
const server = Bun.serve({ port: config.port, fetch: app.fetch, idleTimeout: 60 })
console.log(`skelbert listening on http://localhost:${server.port}`)

const shutdown = () => {
  void server.stop()
  db.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
