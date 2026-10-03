import 'fake-indexeddb/auto'
import { Dexie } from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import type { SuggestionDraft } from '../../src/claude/findings'
import { SkelbertDb } from '../../src/db/db'
import { addNote } from '../../src/db/notes'
import { startNewSession, startOrResumeSession } from '../../src/db/sessions'
import { acceptSuggestion, addSuggestions, dismissSuggestion, restoreSuggestion, saveRepoInstructions } from '../../src/db/suggestions'
import { buildReport } from '../../src/review/report'

const opened: Dexie[] = []
const open = (name: string) => {
  const db = new SkelbertDb(name)
  opened.push(db)
  return db
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.delete()))
})

const start = { repoId: 1, branch: 'feature', headSha: 'h1', baseSha: 'b1' }
const anchor = { line: 3, side: 'new' as const, text: '  console.log(sum)', before: ['a'], after: ['b'] }
const draft = (overrides: Partial<SuggestionDraft> = {}): SuggestionDraft => ({
  path: 'src/cart.ts',
  anchor,
  severity: 'suggestion',
  title: 'Leftover debug log',
  body: '**Leftover debug log**\n\nRemove it.',
  ...overrides,
})

describe('suggestions', () => {
  it('saves findings as suggested Claude notes', async () => {
    const db = open('suggest-save')
    const sessionId = await startOrResumeSession(db, start)
    expect(await addSuggestions(db, sessionId, [draft()])).toEqual({ added: 1, duplicates: 0 })
    const [note] = await db.notes.where({ sessionId }).toArray()
    expect(note).toMatchObject({ status: 'suggested', source: 'claude', title: 'Leftover debug log', anchor, path: 'src/cart.ts' })
  })

  it('skips findings with the same anchor and title on a re-run, whatever their status', async () => {
    const db = open('suggest-dedupe')
    const sessionId = await startOrResumeSession(db, start)
    await addSuggestions(db, sessionId, [draft(), draft({ title: 'Missing test', body: 'Add one.' })])
    const [first, second] = await db.notes.where({ sessionId }).toArray()
    await acceptSuggestion(db, first!.id!)
    await dismissSuggestion(db, second!.id!)

    const rerun = await addSuggestions(db, sessionId, [
      draft({ title: 'leftover debug LOG' }),
      draft({ title: 'Missing test' }),
      draft({ title: 'Missing test' }),
      draft({ anchor: { ...anchor, line: 4 } }),
      draft({ path: 'src/other.ts' }),
    ])
    expect(rerun).toEqual({ added: 2, duplicates: 3 })
    expect(await db.notes.where({ sessionId }).count()).toBe(4)
  })

  it('does not treat my own notes on the same line as duplicates', async () => {
    const db = open('suggest-mine')
    const sessionId = await startOrResumeSession(db, start)
    await addNote(db, { sessionId, path: 'src/cart.ts', anchor, body: 'Leftover debug log', severity: 'nit' })
    expect(await addSuggestions(db, sessionId, [draft()])).toEqual({ added: 1, duplicates: 0 })
  })

  it('accepts into an open Claude note, dismisses, and restores', async () => {
    const db = open('suggest-status')
    const sessionId = await startOrResumeSession(db, start)
    await addSuggestions(db, sessionId, [draft(), draft({ title: 'Other' })])
    const [a, b] = await db.notes.where({ sessionId }).toArray()
    await acceptSuggestion(db, a!.id!)
    await dismissSuggestion(db, b!.id!)
    expect(await db.notes.get(a!.id!)).toMatchObject({ status: 'open', source: 'claude' })
    expect(await db.notes.get(b!.id!)).toMatchObject({ status: 'dismissed', source: 'claude' })
    await restoreSuggestion(db, b!.id!)
    expect((await db.notes.get(b!.id!))?.status).toBe('suggested')
  })

  it('carries accepted suggestions into a new session but not pending or dismissed ones', async () => {
    const db = open('suggest-carry')
    const first = await startOrResumeSession(db, start)
    await addSuggestions(db, first, [draft(), draft({ title: 'Pending' }), draft({ title: 'Dismissed' })])
    const [accepted, , dismissed] = await db.notes.where({ sessionId: first }).toArray()
    await acceptSuggestion(db, accepted!.id!)
    await dismissSuggestion(db, dismissed!.id!)
    const second = await startNewSession(db, { ...start, headSha: 'h2' })
    const carried = await db.notes.where({ sessionId: second }).toArray()
    expect(carried.map((note) => [note.title, note.status, note.source])).toEqual([['Leftover debug log', 'open', 'claude']])
  })

  it('exports accepted Claude notes only', async () => {
    const db = open('suggest-report')
    const sessionId = await startOrResumeSession(db, start)
    await addSuggestions(db, sessionId, [draft(), draft({ title: 'Pending', body: '**Pending**' }), draft({ title: 'Nope', body: '**Nope**' })])
    const [accepted, , dismissed] = await db.notes.where({ sessionId }).toArray()
    await acceptSuggestion(db, accepted!.id!)
    await dismissSuggestion(db, dismissed!.id!)
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

  it('stores trimmed repo instructions on the repo', async () => {
    const db = open('suggest-instructions')
    const repoId = (await db.repos.add({
      dirHandle: {} as FileSystemDirectoryHandle,
      owner: 'me',
      name: 'repo',
      folderName: 'repo',
      baseBranch: 'main',
      checklistIds: [],
      lastOpenedAt: 0,
    })) as number
    await saveRepoInstructions(db, repoId, '  never flag onboarding code \n')
    expect((await db.repos.get(repoId))?.claudeInstructions).toBe('never flag onboarding code')
  })
})
