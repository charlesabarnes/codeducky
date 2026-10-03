import 'fake-indexeddb/auto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chunkReviewer, createClaudeClient } from '../../src/claude/client'
import { describeClaudeError } from '../../src/claude/errors'
import { runPass, type PassDeps } from '../../src/claude/pass'
import { systemPrompt } from '../../src/claude/prompt'
import { SkelbertDb } from '../../src/db/db'
import { applyReanchoring } from '../../src/db/notes'
import { startOrResumeSession } from '../../src/db/sessions'
import { acceptSuggestion, addSuggestions } from '../../src/db/suggestions'
import { createGitService } from '../../src/git/service'
import { sideLines } from '../../src/review/lines'
import { reanchorNotes } from '../../src/review/reanchor'
import { fakeFetch, streamReply, type RecordedRequest } from '../support/fakeAnthropic'
import { nodeDirectoryHandle } from '../support/nodeHandle'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd()

const BASE = ['export function total(items) {', '  let sum = 0', '  for (const item of items) sum += item.price', '  return sum', '}', ''].join('\n')
const FEATURE = BASE.replace('  return sum', '  console.log(sum)\n  return sum')

/** Plays Claude: flags the debug log wherever it appears in the diff it was sent. */
function reviewer(request: RecordedRequest) {
  const prompt = (request.body.messages as { content: string }[])[0]!.content
  const path = /<diff path="([^"]+)">/.exec(prompt)![1]!
  const line = prompt.split('\n').find((row) => row.startsWith('+') && row.includes('console.log'))
  const findings = line
    ? [
        {
          path,
          side: 'new',
          line: Number(/^\+\s*(\d+)/.exec(line)![1]),
          line_text: line.slice(line.indexOf('| ') + 2),
          severity: 'suggestion',
          title: 'Leftover debug log',
          body: 'Remove the `console.log`.',
        },
      ]
    : []
  return streamReply({ text: JSON.stringify({ findings }), usage: { input_tokens: 900, output_tokens: 120 } })
}

describe('Claude pass on a real repository', () => {
  let repo = ''
  const service = createGitService()
  let baseSha = ''

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'skelbert-claude-'))
    git(repo, 'init', '--quiet', '-b', 'main')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src/cart.ts'), BASE)
    writeFileSync(join(repo, 'src/old.ts'), 'export const old = 1\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '--quiet', '-m', 'base')
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(repo, 'checkout', '--quiet', '-b', 'feature/log')
    writeFileSync(join(repo, 'src/cart.ts'), FEATURE)
    writeFileSync(join(repo, 'src/clean.ts'), 'export const clean = true\n')
    rmSync(join(repo, 'src/old.ts'))
    await service.open(nodeDirectoryHandle(repo))
    baseSha = (await service.resolveBase('main')).mergeBaseSha
  })

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  it('turns findings into anchored suggestions and skips them on re-runs after edits', async () => {
    const db = new SkelbertDb('claude-pass-checkpoint')
    try {
      const sessionId = await startOrResumeSession(db, { repoId: 'r1', branch: 'feature/log', headSha: 'h', baseSha })
      const fake = fakeFetch(reviewer)
      const client = createClaudeClient({ apiKey: 'sk-test', fetch: fake.fetch, maxRetries: 0 })
      const deps: PassDeps = {
        loadContents: (file) => service.contents(file),
        review: chunkReviewer(client, 'claude-opus-5-5', systemPrompt('Never flag onboarding code.')),
        save: (drafts) => addSuggestions(db, sessionId, drafts),
        describe: (error) => describeClaudeError(error, 'claude-opus-5-5'),
      }
      const pass = async () =>
        runPass(await service.changes(baseSha), deps, { signal: new AbortController().signal, onProgress: () => {} })

      const first = await pass()
      expect(first.status).toBe('done')
      expect(first.files.map((file) => [file.path, file.state])).toEqual([
        ['src/cart.ts', 'done'],
        ['src/clean.ts', 'done'],
        ['src/old.ts', 'skipped'],
      ])
      expect(fake.requests).toHaveLength(2)
      expect(first.usage).toMatchObject({ requests: 2, inputTokens: 1800, outputTokens: 240 })
      const [note] = await db.notes.where({ sessionId }).toArray()
      expect(note).toMatchObject({
        path: 'src/cart.ts',
        status: 'suggested',
        source: 'claude',
        anchor: { line: 4, side: 'new', text: '  console.log(sum)' },
      })

      const second = await pass()
      expect(second.files[0]).toMatchObject({ added: 0, duplicates: 1 })

      await acceptSuggestion(db, note!.id!)
      writeFileSync(join(repo, 'src/cart.ts'), `// header\n\n${readFileSync(join(repo, 'src/cart.ts'), 'utf8')}`)
      const changes = await service.changes(baseSha)
      const lines = sideLines((await service.contents(changes.find((file) => file.path === 'src/cart.ts')!)).new)
      await applyReanchoring(db, reanchorNotes(await db.notes.toArray(), () => lines))
      expect((await db.notes.get(note!.id!))!.anchor.line).toBe(6)

      const third = await pass()
      expect(third.files[0]).toMatchObject({ added: 0, duplicates: 1 })
      expect(await db.notes.where({ sessionId }).count()).toBe(1)
      expect((await db.notes.get(note!.id!))!.status).toBe('open')
    } finally {
      await db.delete()
    }
  })
})
