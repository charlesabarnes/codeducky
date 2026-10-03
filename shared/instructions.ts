/** Repo review instructions, written on the repo page and served over MCP. */
export const MAX_INSTRUCTIONS = 20_000

interface WithInstructions {
  instructions?: unknown
  /** The field's name before v3; records synced from an older client may still carry it. */
  claudeInstructions?: unknown
}

export function repoInstructions(repo: WithInstructions): string {
  const value = typeof repo.instructions === 'string' ? repo.instructions : repo.claudeInstructions
  return typeof value === 'string' ? value.trim() : ''
}
