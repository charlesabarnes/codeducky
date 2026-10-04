/** The MCP endpoint the sync server serves next to the app. */
export const mcpUrl = (origin: string) => `${origin}/mcp`

/** The command that registers Rubberduck in Claude Code, with OAuth or, given a token, a static bearer header. */
export function claudeAddCommand(url: string, token?: string): string {
  const base = `claude mcp add --transport http rubberduck ${url}`
  return token ? `${base} --header "Authorization: Bearer ${token}"` : base
}
