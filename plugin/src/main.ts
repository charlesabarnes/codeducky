import { randomUUID } from 'node:crypto'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createChannelServer, VERSION } from './channel'
import { currentBranch, readCheckout, systemGit } from './checkout'
import { resolveConfig, systemSources } from './config'
import { createConnection, type Connection, type ServerEvent } from './connection'

const BRANCH_POLL_MS = 30_000

const log = (message: string) => console.error(`skelbert channel: ${message}`)

// Claude Code starts plugin servers in the session's directory; CLAUDE_PROJECT_DIR wins when it is set.
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const git = systemGit(cwd)
const checkout = readCheckout(cwd, git)
const config = resolveConfig(systemSources(cwd))
const id = randomUUID()
let branch = checkout.branch

let connection: Connection | null = null
const send = (event: ServerEvent) => connection?.send(event) ?? Promise.resolve(false)
const channel = createChannelServer({ send, log, configError: config.ok ? null : config.error })

await channel.mcp.connect(new StdioServerTransport())

if (!config.ok) {
  log(config.error)
} else {
  connection = createConnection({
    config: config.config,
    registration: () => ({
      id,
      label: checkout.label,
      cwd: checkout.cwd,
      repo: checkout.repo,
      branch,
      hostname: checkout.hostname,
      pluginVersion: VERSION,
    }),
    onTask: (task) => channel.deliverTask(task),
    onVerdict: (verdict) => channel.deliverVerdict(verdict),
    log,
  })
  void connection.start()
}

const poll = setInterval(() => {
  const next = currentBranch(git)
  if (next === branch) return
  branch = next
  void connection?.send({ type: 'update', branch })
}, BRANCH_POLL_MS)

let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  clearInterval(poll)
  await connection?.stop()
  process.exit(0)
}

// Claude Code closes stdin when the session ends.
channel.mcp.onclose = () => void shutdown()
process.stdin.on('end', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
