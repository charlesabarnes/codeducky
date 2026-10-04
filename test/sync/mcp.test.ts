import { describe, expect, it } from 'vitest'
import { claudeAddCommand, mcpUrl } from '../../src/sync/mcp'

describe('Claude Code connection', () => {
  it('builds the MCP URL and the claude mcp add commands', () => {
    const url = mcpUrl('https://codeducky.example.com')
    expect(url).toBe('https://codeducky.example.com/mcp')
    expect(claudeAddCommand(url)).toBe('claude mcp add --transport http codeducky https://codeducky.example.com/mcp')
    expect(claudeAddCommand(url, 'cdb_abc')).toBe(
      'claude mcp add --transport http codeducky https://codeducky.example.com/mcp --header "Authorization: Bearer cdb_abc"',
    )
  })
})
