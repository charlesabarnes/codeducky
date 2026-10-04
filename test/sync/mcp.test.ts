import { describe, expect, it } from 'vitest'
import { claudeAddCommand, mcpUrl } from '../../src/sync/mcp'

describe('Claude Code connection', () => {
  it('builds the MCP URL and the claude mcp add commands', () => {
    const url = mcpUrl('https://rubberduck.example.com')
    expect(url).toBe('https://rubberduck.example.com/mcp')
    expect(claudeAddCommand(url)).toBe('claude mcp add --transport http rubberduck https://rubberduck.example.com/mcp')
    expect(claudeAddCommand(url, 'skb_abc')).toBe(
      'claude mcp add --transport http rubberduck https://rubberduck.example.com/mcp --header "Authorization: Bearer skb_abc"',
    )
  })
})
