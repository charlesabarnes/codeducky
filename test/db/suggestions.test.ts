import 'fake-indexeddb/auto'
import { Dexie } from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { SkelbertDb } from '../../src/db/db'
import { saveRepoInstructions } from '../../src/db/repos'
import type { Note, NoteSource } from '../../src/db/schema'
import { startNewSession, startOrResumeSession } from '../../src/db/sessions'
import { acceptSuggestion, dismissSuggestion, restoreSuggestion } from '../../src/db/suggestions'
import { buildReport } from '../../src/review/report'
import { repoInstructions } from '../../shared/instructions'

const opened: Dexie[] = []
const open = (name: string) => {
  const db = new SkelbertDb(name)
  opened.push(db)
  return db
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.delete()))
})

const start = { repoId: 'r1', branch: 'feature', headSha: 'h1', baseSha: 'b1' }
const anchor = { line: 3, side: 'new' as const, text: '  console.log(sum)', before: ['a'], after: ['b'] }

/** A suggested note as add_note (MCP) or, for old data, the removed Claude pass left it. */
async function suggest(db: SkelbertDb, sessionId: string, title: string, source: NoteSource = 'mcp'): Promise<string> {
  const note: Note = { sessionId, path: 'src/cart.ts', anchor, title, body: `**${title}**`, severity: 'suggestion', status: 'suggested', source, createdAt: 1, updatedAt: 1 }
  return (await db.notes.add(note)) as string
}

describe('suggestions', () => {
  it('accepts into an open note, dismisses, and restores', async () => {
    const db = open('suggest-status')
    const sessionId = await startOrResumeSession(db, start)
    const a = await suggest(db, sessionId, 'Leftover debug log')
    const b = await suggest(db, sessionId, 'Other')
    await acceptSuggestion(db, a)
    await dismissSuggestion(db, b)
    expect(await db.notes.get(a)).toMatchObject({ status: 'open', source: 'mcp' })
    expect(await db.notes.get(b)).toMatchObject({ status: 'dismissed', source: 'mcp' })
    await restoreSuggestion(db, b)
    expect((await db.notes.get(b))?.status).toBe('suggested')
  })

  it('carries accepted suggestions into a new session but not pending or dismissed ones', async () => {
    const db = open('suggest-carry')
    const first = await startOrResumeSession(db, start)
    const accepted = await suggest(db, first, 'Leftover debug log')
    await suggest(db, first, 'Pending')
    await dismissSuggestion(db, await suggest(db, first, 'Dismissed'))
    await acceptSuggestion(db, accepted)
    const second = await startNewSession(db, { ...start, headSha: 'h2' })
    const carried = await db.notes.where({ sessionId: second }).toArray()
    expect(carried.map((note) => [note.title, note.status, note.source])).toEqual([['Leftover debug log', 'open', 'mcp']])
  })

  it('exports accepted suggestions only, and still labels old Claude-pass notes', async () => {
    const db = open('suggest-report')
    const sessionId = await startOrResumeSession(db, start)
    await acceptSuggestion(db, await suggest(db, sessionId, 'Leftover debug log', 'claude'))
    await suggest(db, sessionId, 'Pending')
    await dismissSuggestion(db, await suggest(db, sessionId, 'Nope'))
    const markdown = buildReport({
      repoName: 'me/repo',
      baseBranch: 'main',
      session: (await db.sessions.get(sessionId))!,
      notes: await db.notes.where({ sessionId }).toArray(),
      checklists: [],
    })
    expect(markdown).toContain('**Leftover debug log**')
    expect(markdown).toContain('**suggestion** · open · line 3 · from Claude')
    expect(markdown).toContain('- Notes: 1 note (1 open); 1 suggestion')
    expect(markdown).not.toContain('Pending')
    expect(markdown).not.toContain('Nope')
  })
})

describe('repo instructions', () => {
  it('stores trimmed instructions and drops the legacy field', async () => {
    const db = open('repo-instructions')
    const repoId = (await db.repos.add({
      owner: 'me',
      name: 'repo',
      folderName: 'repo',
      baseBranch: 'main',
      checklistIds: [],
      lastOpenedAt: 0,
      claudeInstructions: 'old text',
    })) as string
    expect(repoInstructions((await db.repos.get(repoId))!)).toBe('old text')
    await saveRepoInstructions(db, repoId, '  never flag onboarding code \n')
    const repo = (await db.repos.get(repoId))!
    expect(repo.instructions).toBe('never flag onboarding code')
    expect('claudeInstructions' in repo).toBe(false)
    expect(repoInstructions(repo)).toBe('never flag onboarding code')
  })

  it('lets an explicitly empty value win over a legacy one', () => {
    expect(repoInstructions({ instructions: '', claudeInstructions: 'old' })).toBe('')
    expect(repoInstructions({})).toBe('')
  })
})
