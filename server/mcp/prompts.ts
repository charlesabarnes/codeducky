import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { repoInstructions } from '../../shared/instructions'
import { repoMatches, type DataSnapshot } from './records'

interface Target {
  repo?: string
  branch?: string
}

const args = {
  repo: z.string().optional().describe('Repository as "owner/name". Defaults to the origin remote of the current checkout.'),
  branch: z.string().optional().describe('Branch name. Defaults to the branch checked out in the current directory.'),
}

function locate({ repo, branch }: Target): string {
  const repoStep = repo
    ? `The repo is ${repo}.`
    : 'Work out the repo as "owner/name" from `git remote get-url origin` in the current directory.'
  const branchStep = branch ? `The branch is ${branch}.` : 'The branch is the one checked out (`git branch --show-current`).'
  return `${repoStep} ${branchStep}`
}

/** The repo's instructions, inlined when the repo is named up front; otherwise get_review_context carries them. */
function instructionsBlock(data: DataSnapshot, repo: string | undefined): string {
  if (!repo) return ''
  const text = data.repos.filter((r) => repoMatches(r, repo)).map(repoInstructions).find(Boolean)
  return text ? `\n\nRepo instructions from the owner (they take precedence over the defaults above):\n<repo-instructions>\n${text}\n</repo-instructions>` : ''
}

/** Clients send blank strings for arguments the user skipped. */
const clean = ({ repo, branch }: Target): Target => ({ repo: repo?.trim() || undefined, branch: branch?.trim() || undefined })

const message = (text: string): GetPromptResult => ({ messages: [{ role: 'user', content: { type: 'text', text } }] })

export function reviewPrompt(data: DataSnapshot, target: Target): GetPromptResult {
  return message(`Review my branch before I push it, the way I would review my own change, and record each finding in Skelbert.

1. ${locate(target)}
2. Call the Skelbert tool get_review_context with repo and branch. It returns this repo's review instructions, the checklists, the files Skelbert saw changed, notes that are already open or suggested, and patterns that recurred in past reviews of this repo. If it reports that there is no session, tell me to open the branch in Skelbert first and stop.
3. Read the diff in the local checkout: run \`git merge-base HEAD origin/<baseBranch>\` (baseBranch comes from get_review_context; fall back to the remote's default branch), then \`git diff <merge-base>\`, which includes uncommitted changes. Open the surrounding code wherever you need more context.
4. Look for:
   - bugs and wrong logic;
   - edge cases that are not handled: empty or missing input, null/undefined, errors and failures, limits, ordering and concurrency;
   - missing or weak tests for behaviour the diff adds or changes;
   - leftover debug code: logging added while debugging, debugger statements, commented-out code, focused or skipped tests, stray TODOs added in this diff;
   - names that are unclear or no longer match what the code does.
   Check the recurring patterns from get_review_context first; they are mistakes I tend to repeat here.
   Do not report style nits, formatting or matters of taste, or anything a linter or formatter would catch.
5. Follow the repo instructions from get_review_context. They override these defaults.
6. For each real finding, call add_note with repo and branch, the file path, the line number on the new side (the working tree file, 1-based), a severity (blocker: must not ship; issue: should be fixed before pushing; suggestion: worth considering), a short title, and a body that explains the problem and a concrete fix. Pass lineText with the exact text of that line, and before/after with up to 3 lines of context, so the note stays anchored when the file changes. Skip anything already covered by an open or suggested note.
7. Do not edit files. Finish with a short summary: the notes you added by severity, and anything you were unsure about.${instructionsBlock(data, target.repo)}`)
}

export function fixPrompt(data: DataSnapshot, target: Target): GetPromptResult {
  return message(`Work through the Skelbert review notes on my branch and fix them in the code.

1. ${locate(target)}
2. Call the Skelbert tool get_review_context with repo and branch for the repo instructions and the open notes. Open notes include suggestions I accepted. Leave pending suggestions (status "suggested") and dismissed notes alone unless I say otherwise.
3. Take the notes one at a time, blockers first, then issues, suggestions and nits:
   - Find the code from the note's anchor (the line text plus the lines around it); line numbers may have moved. If the anchor is lost or the code is gone, check whether it is already fixed.
   - Make the smallest change that fixes it, following the repo instructions and the code's existing style.
   - Run the tests that cover the change (the test file next to the code, or the project's test command for that area) and fix any failure you caused.
   - Call resolve_note with the note id and a short reply: what changed and where, and which tests you ran.
4. Ask me before a large refactor, a change to a public interface, or a fix that spreads across many files, and when a note is unclear or you disagree with it. Leave that note open until I answer.
5. Never push. Leave the changes uncommitted unless I ask you to commit.
6. Finish with a list of the notes you resolved, and the ones you left open and why.${instructionsBlock(data, target.repo)}`)
}

export function registerPrompts(server: McpServer, data: () => DataSnapshot) {
  server.registerPrompt(
    'review',
    {
      title: 'Review this branch',
      description: 'Self-review the current branch against its merge base and add findings to Skelbert as suggested notes.',
      argsSchema: args,
    },
    (target) => reviewPrompt(data(), clean(target)),
  )
  server.registerPrompt(
    'fix',
    {
      title: 'Fix review notes',
      description: 'Fix the open and accepted Skelbert notes on the current branch, run the tests, and resolve each note with a reply.',
      argsSchema: args,
    },
    (target) => fixPrompt(data(), clean(target)),
  )
}
