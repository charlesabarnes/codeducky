/**
 * "Open in Claude Code" links: claude-cli://open?repo=<owner/name>&q=<prompt>, per
 * https://code.claude.com/docs/en/deep-links. The prompt is typed into a new terminal session but not
 * sent; `repo` opens the clone where `claude` last ran for that GitHub slug.
 */

/** The documented maximum length of `q`. */
export const MAX_PROMPT = 5000

export type LinkKind = 'review' | 'fix'

export interface LinkTarget {
  /** GitHub "owner/name". */
  repo: string
  branch: string
  pr?: { number: number; headRef: string } | null
}

export function claudeDeepLink(repo: string, prompt: string): string {
  const q = encodeURIComponent(prompt.slice(0, MAX_PROMPT))
  // encodeURIComponent turns the slug's slash into %2F; the docs write it plain.
  const slug = encodeURIComponent(repo).replace(/%2F/gi, '/')
  return `claude-cli://open?repo=${slug}&q=${q}`
}

const selector = ({ repo, branch, pr }: LinkTarget) =>
  pr ? `repo "${repo}" and pr ${pr.number}` : `repo "${repo}" and branch "${branch}"`

export function linkPrompt(kind: LinkKind, target: LinkTarget): string {
  const { repo, branch, pr } = target
  if (kind === 'review') {
    if (pr) {
      return `Review pull request ${repo}#${pr.number} with Rubberduck. Call the Rubberduck MCP tool get_review_context with ${selector(target)} for the review instructions, checklists and existing notes, read the diff with \`gh pr diff ${pr.number}\` without switching branches, and record each finding with add_note (${selector(target)}). Do not edit files.`
    }
    return `Review branch ${branch} of ${repo} with Rubberduck, as the /mcp__rubberduck__review prompt does (\`/mcp__rubberduck__review ${repo} ${branch}\`). Call the Rubberduck MCP tool get_review_context with ${selector(target)}, review the diff against the merge base, and record each finding with add_note. Do not edit files.`
  }
  if (pr) {
    return `Fix my accepted Rubberduck notes on pull request ${repo}#${pr.number} (head branch ${pr.headRef}, which must be checked out here). Call the Rubberduck MCP tool get_review_context with ${selector(target)}, fix the open notes one at a time (blockers first), run the tests that cover each change, and close each note with resolve_note and a short reply. Never push.`
  }
  return `Fix my accepted Rubberduck notes on branch ${branch} of ${repo}, as the /mcp__rubberduck__fix prompt does (\`/mcp__rubberduck__fix ${repo} ${branch}\`). Call the Rubberduck MCP tool get_review_context with ${selector(target)}, fix the open notes one at a time (blockers first), run the tests that cover each change, and close each note with resolve_note and a short reply. Never push.`
}

/** A custom prompt with the context Claude needs to find the review in Rubberduck. */
export function customPrompt(message: string, target: LinkTarget): string {
  const where = target.pr ? `pull request ${target.repo}#${target.pr.number}` : `branch ${target.branch} of ${target.repo}`
  const context = `\n\n(Context: my Rubberduck review of ${where}. The Rubberduck MCP tools get_review_context, list_notes, add_note and resolve_note take ${selector(target)}.)`
  return `${message.trim().slice(0, MAX_PROMPT - context.length)}${context}`
}
