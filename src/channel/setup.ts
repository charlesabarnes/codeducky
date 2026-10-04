/** Setup commands for the channel plugin, as shown in Settings. Nothing here runs them. */

export const MARKETPLACE_REPO = 'charlesabarnes/skelbert'
export const PLUGIN_ID = 'skelbert@skelbert'
/** Claude Code names plugin MCP tools mcp__plugin_<plugin>_<server>__<tool>. */
export const STATUS_TOOL_ID = 'mcp__plugin_skelbert_channel__report_status'

export const marketplaceAddCommand = () => `claude plugin marketplace add ${MARKETPLACE_REPO}`
export const pluginInstallCommand = () => `claude plugin install ${PLUGIN_ID}`
export const serverUrlCommand = (origin: string) => `git config --global skelbert.url ${origin}`

/**
 * Custom channels are not on the research-preview allowlist, so `--channels` does not register them;
 * the development flag does, after a confirmation prompt.
 */
export const startCommand = (allowStatus = true) =>
  `claude --dangerously-load-development-channels plugin:${PLUGIN_ID}${allowStatus ? ` --allowedTools ${STATUS_TOOL_ID}` : ''}`
