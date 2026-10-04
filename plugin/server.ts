#!/usr/bin/env bun
/**
 * Entry point Claude Code spawns (see .claude-plugin/plugin.json). stdout is the MCP transport, so
 * nothing here may print to it. Installs the dependencies on first run, like the official channel
 * plugins, then starts the channel.
 */
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

function resolvable(specifier: string): boolean {
  try {
    import.meta.resolve(specifier)
    return true
  } catch {
    return false
  }
}

if (!resolvable('@modelcontextprotocol/sdk/server/index.js')) {
  const result = spawnSync(process.execPath, ['install', '--no-summary', '--production'], { cwd: root, stdio: ['ignore', 2, 2] })
  if (result.status !== 0) {
    console.error('codeducky channel: bun install failed in', root)
    process.exit(1)
  }
}

await import('./src/main.ts')
