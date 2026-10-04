import { lineSpan } from '../../shared/anchor'
import { MAX_NOTE_EXCERPT, type TaskRequest } from '../../shared/channel'
import { prUrl } from '../../shared/links'
import type { DataSnapshot } from '../mcp/records'
import { fixPrompt, reviewPrompt } from '../mcp/prompts'
import type { TaskMeta } from './registry'

const promptText = (result: ReturnType<typeof reviewPrompt>) => {
  const content = result.messages[0]?.content
  return content && content.type === 'text' ? content.text : ''
}

function where({ repo, branch, pr }: TaskRequest['target']): string {
  return pr ? `pull request ${repo}#${pr}` : `branch ${branch} of ${repo}`
}

function selector({ repo, branch, pr }: TaskRequest['target']): string {
  return pr ? `repo "${repo}" and pr ${pr}` : `repo "${repo}" and branch "${branch}"`
}

function prReview(target: TaskRequest['target']): string {
  const { repo, pr } = target
  return `Review ${where(target)} and record each finding in Code Ducky.

1. Call the Code Ducky tool get_review_context with ${selector(target)}. It returns the repo's review instructions (follow them), the checklists, the changed files, notes already open or suggested on this pull request, and mistakes that recurred in past reviews. If it reports that there is no session, tell me to open the pull request in Code Ducky first and stop.
2. Read the pull request's diff without switching this checkout's branch: \`gh pr diff ${pr}\` when the GitHub CLI is available, otherwise \`git fetch origin pull/${pr}/head\` and diff FETCH_HEAD against its merge base with the base branch. Open the surrounding code wherever you need more context.
3. Look for bugs and wrong logic, edge cases that are not handled, missing tests, leftover debug code, and names that no longer match what the code does. Skip style nits and anything a linter would catch.
4. For each real finding, call add_note with ${selector(target)}, the file path, the line on the new side (with endLine for a finding that spans several lines), a severity (blocker, issue or suggestion), a short title and a body with a concrete fix. Pass lineText, before and after so the note stays anchored. Skip anything an existing note covers.
5. Do not edit files. Finish with a short summary of the notes you added.

The same review is the /mcp__codeducky__review prompt for a branch; for ${repo} this task targets the pull request instead.`
}

function prFix(target: TaskRequest['target']): string {
  return `Fix the Code Ducky review notes on ${where(target)}.

1. Call the Code Ducky tool get_review_context with ${selector(target)} for the repo instructions and the open notes (open notes include suggestions I accepted; leave pending suggestions and dismissed notes alone).
2. Check that this checkout has the pull request's head branch checked out (headRef from get_review_context). If it does not, stop and tell me which branch to check out.
3. Take the notes one at a time, blockers first: find the code from the note's anchor, make the smallest fix, run the tests that cover it, then call resolve_note with the note id and a short reply saying what changed and which tests ran.
4. Ask me before a large refactor or a change to a public interface. Never push, and leave the changes uncommitted.
5. Finish with the notes you resolved and the ones you left open, and why.

This is the /mcp__codeducky__fix prompt, aimed at a pull request.`
}

function custom(request: TaskRequest): string {
  const { target, message = '', notes = [] } = request
  const parts = [message.trim()]
  parts.push(
    `Context: this comes from my Code Ducky review of ${where(target)}. The Code Ducky MCP tools (get_review_context, list_notes, get_note, add_note, resolve_note) select it with ${selector(target)}.`,
  )
  if (notes.length > 0) {
    const lines = notes.map((note) => {
      const excerpt = note.body.length > MAX_NOTE_EXCERPT ? `${note.body.slice(0, MAX_NOTE_EXCERPT)}…` : note.body
      const title = note.title ? ` ${note.title}:` : ''
      return `- [${note.severity}] ${note.path}:${lineSpan(note)}${title} ${excerpt.replace(/\s+/g, ' ').trim()} (note id ${note.id})`
    })
    parts.push(`Notes I picked for this (get_note has the full text):\n${lines.join('\n')}`)
  }
  return parts.filter(Boolean).join('\n\n')
}

/** The text Claude receives for a task: the same instructions as the MCP prompts for branches. */
export function taskContent(data: DataSnapshot, request: TaskRequest): string {
  const { kind, target } = request
  if (kind === 'custom') return custom(request)
  if (target.pr) return kind === 'review' ? prReview(target) : prFix(target)
  const promptTarget = { repo: target.repo, branch: target.branch }
  return promptText(kind === 'review' ? reviewPrompt(data, promptTarget) : fixPrompt(data, promptTarget))
}

/** The <channel> tag attributes: identifier keys only, string values. */
export function taskMeta(request: TaskRequest, origin: string): TaskMeta {
  const { kind, target } = request
  const meta: TaskMeta = { kind, repo: target.repo }
  if (target.branch) meta.branch = target.branch
  if (target.pr) {
    meta.pr = String(target.pr)
    const [owner = '', name = ''] = target.repo.split('/')
    meta.session_url = prUrl(origin, { owner, name, number: target.pr })
  } else if (target.sessionId) {
    meta.session_url = `${origin}/sessions/${encodeURIComponent(target.sessionId)}`
  }
  if (target.sessionId) meta.codeducky_session = target.sessionId
  return meta
}
