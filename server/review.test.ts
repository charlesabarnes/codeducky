import { afterEach, describe, expect, it } from 'bun:test'
import type { CallToolResult, GetPromptResult } from '@modelcontextprotocol/sdk/types.js'
import type { SyncResponse, WireChange } from '../shared/sync'
import { checklist, note, record, repo, REPO, session, ticked } from './fixtures'
import { recurringPatterns } from './review/patterns'
import { login, makeApp, mcpClient, request } from './testing'
import { ADMIN_USER_ID } from './users/store'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

const FILES = [
  { path: 'src/invoice.ts', status: 'modified', additions: 12, deletions: 3 },
  { path: 'src/tax.ts', status: 'added', additions: 40, deletions: 0 },
  { path: 'logo.png', status: 'modified', binary: true },
]

const SEED: WireChange[] = [
  repo({ instructions: 'Never flag generated code under src/gen.' }),
  record('repos', 'gh:x/legacy', { owner: 'x', name: 'legacy', folderName: 'legacy', baseBranch: 'main', lastOpenedAt: 1, checklistIds: [], claudeInstructions: 'Old instructions' }),
  record('sessions', 's-legacy', { repoId: 'gh:x/legacy', branch: 'main', headSha: 'h', baseSha: 'b', baseSource: 'local', startedAt: 1, status: 'active' }),
  session('s1', 'feature/tax', { files: FILES }),
  session('s-past', 'feature/old', { startedAt: 1 }),
  note('n-open', 's1', { title: 'Rounding error' }),
  note('n-suggested', 's1', { status: 'suggested', source: 'mcp', severity: 'suggestion' }),
  note('n-resolved-here', 's1', { status: 'resolved' }),
  note('p1', 's-past', { status: 'resolved', title: 'Leftover console.log', body: 'Remove the debug console.log', resolution: { by: 'me', text: 'Removed it.', at: 1 } }),
  note('p2', 's-past', { status: 'resolved', title: 'leftover console.log.', body: 'Debug console.log left in' }),
  note('p3', 's-past', { status: 'resolved', title: 'Missing test for empty cart', body: 'No test covers an empty cart' }),
  note('p4', 's-past', { status: 'open', title: 'Leftover console.log' }),
  checklist('cl', 'Before push', [['i1', 'Tests pass']], { required: true }),
  ticked('s1', 'i1'),
]

async function setup() {
  const made = makeApp()
  cleanups.push(made.cleanup)
  const device = await login(made.app)
  const pushed = (await (await request(made.app, 'POST', '/api/sync', { cursor: 0, changes: SEED }, device)).json()) as SyncResponse
  expect(pushed.rejected).toEqual([])
  const { token } = made.tokens.issue({ userId: ADMIN_USER_ID, name: 'Claude Code', kind: 'api' })
  const client = await mcpClient(made.app, token)
  cleanups.push(() => void client.close())
  const prompt = async (name: string, args: Record<string, string> = {}) => {
    const result = (await client.getPrompt({ name, arguments: args })) as GetPromptResult
    return (result.messages[0]!.content as { text: string }).text
  }
  const context = async (args: Record<string, unknown>) => {
    const result = (await client.callTool({ name: 'get_review_context', arguments: args })) as CallToolResult
    const text = (result.content[0] as { text: string }).text
    return result.isError ? { error: text } : JSON.parse(text)
  }
  return { client, prompt, context }
}

describe('get_review_context', () => {
  it('returns instructions, checklists, files, notes and recurring patterns', async () => {
    const { context } = await setup()
    const out = await context({ repo: REPO, branch: 'feature/tax' })
    expect(out).toMatchObject({
      repo: REPO,
      branch: 'feature/tax',
      baseBranch: 'main',
      session: { id: 's1', status: 'active' },
      instructions: 'Never flag generated code under src/gen.',
      checklists: [{ title: 'Before push', required: true, done: '1/1', items: [{ id: 'i1', checked: true }] }],
      files: { scanned: true, count: 3, additions: 52, deletions: 3, list: FILES },
    })
    expect(out.openNotes.map((n: { id: string }) => n.id)).toEqual(['n-open'])
    expect(out.pendingSuggestions.map((n: { id: string }) => n.id)).toEqual(['n-suggested'])
    expect(out.recurring.resolvedNotes).toBe(4)
    expect(out.recurring.titles).toEqual([{ title: 'Leftover console.log', count: 2, severity: 'issue', example: 'Removed it.' }])
    expect(out.recurring.keywords.slice(0, 2)).toEqual([
      { keyword: 'console', count: 2 },
      { keyword: 'debug', count: 2 },
    ])
  })

  it('reads legacy instructions and reports unscanned sessions and unknown branches', async () => {
    const { context } = await setup()
    expect(await context({ repo: 'x/legacy', branch: 'main' })).toMatchObject({
      instructions: 'Old instructions',
      files: { scanned: false, count: 0, list: [] },
    })
    expect((await context({ repo: REPO, branch: 'nope' })).error).toContain('No Code Ducky session')
  })
})

describe('prompts', () => {
  it('lists review and fix with optional repo and branch arguments', async () => {
    const { client } = await setup()
    const { prompts } = await client.listPrompts()
    expect(prompts.map((p) => p.name).sort()).toEqual(['fix', 'review'])
    for (const p of prompts) {
      expect(p.arguments?.map((a) => [a.name, a.required ?? false])).toEqual([
        ['repo', false],
        ['branch', false],
      ])
    }
  })

  it('review points at the tools, the merge-base diff and the self-review focus', async () => {
    const { prompt } = await setup()
    const text = await prompt('review')
    for (const part of ['get_review_context', 'add_note', 'git merge-base HEAD origin/<baseBranch>', 'lineText', 'leftover debug code', 'style nits', 'git remote get-url origin']) {
      expect(text).toContain(part)
    }
    expect(text).not.toContain('<repo-instructions>')
  })

  it('inlines the repo instructions when the repo is named, and ignores blank arguments', async () => {
    const { prompt } = await setup()
    const named = await prompt('review', { repo: REPO, branch: 'feature/tax' })
    expect(named).toContain(`The repo is ${REPO}. The branch is feature/tax.`)
    expect(named).toContain('<repo-instructions>\nNever flag generated code under src/gen.\n</repo-instructions>')
    expect(await prompt('review', { repo: ' ', branch: '' })).toContain('git branch --show-current')
  })

  it('fix resolves notes with a reply, asks before refactors and never pushes', async () => {
    const { prompt } = await setup()
    const text = await prompt('fix', { repo: 'x/legacy' })
    for (const part of ['resolve_note', 'Run the tests', 'Ask me before a large refactor', 'Never push', 'Old instructions']) expect(text).toContain(part)
  })
})

describe('recurringPatterns', () => {
  it('leaves out one-offs and notes without text', () => {
    expect(recurringPatterns([])).toEqual({ resolvedNotes: 0, titles: [], keywords: [] })
  })
})
