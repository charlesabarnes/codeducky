import 'fake-indexeddb/auto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodeDuckyDb } from '../../src/db/db'
import { addNote, applyReanchoring } from '../../src/db/notes'
import { startNewSession, startOrResumeSession } from '../../src/db/sessions'
import { createGitService } from '../../src/git/service'
import type { FileChange } from '../../src/git/types'
import { createAnchor } from '../../src/review/anchor'
import { sideLines } from '../../src/review/lines'
import { reanchorNotes } from '../../src/review/reanchor'
import { buildReport } from '../../src/review/report'
import { contentHash, isViewed } from '../../src/review/viewed'
import { nodeDirectoryHandle } from '../support/nodeHandle'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd()

const PATH = 'src/cart.ts'
const BASE = [
  'export interface Item {',
  '  price: number',
  '  quantity: number',
  '}',
  '',
  'export function total(items: Item[]): number {',
  '  let sum = 0',
  '  for (const item of items) sum += item.price',
  '  return sum',
  '}',
  '',
].join('\n')

const FEATURE = BASE.replace('sum += item.price', 'sum += item.price * item.quantity').concat(
  ['', 'export function isEmpty(items: Item[]): boolean {', '  return items.length == 0', '}', ''].join('\n'),
)

describe('notes across edits and rescans', () => {
  let repo = ''
  const service = createGitService()
  let baseSha = ''

  const write = (text: string) => writeFileSync(join(repo, PATH), text)
  const scan = async (): Promise<{ change: FileChange; lines: ReturnType<typeof sideLines> }> => {
    const changes = await service.changes(baseSha)
    const change = changes.find((entry) => entry.path === PATH)!
    const contents = await service.contents(change)
    return { change, lines: sideLines(contents.new) }
  }

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'codeducky-notes-'))
    git(repo, 'init', '--quiet', '-b', 'main')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'remote', 'add', 'origin', 'git@github.com:me/cart.git')
    mkdirSync(join(repo, 'src'))
    write(BASE)
    git(repo, 'add', '.')
    git(repo, 'commit', '--quiet', '-m', 'base')
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(repo, 'checkout', '--quiet', '-b', 'feature/quantity')
    write(FEATURE)
    await service.open(nodeDirectoryHandle(repo))
    baseSha = (await service.resolveBase('main')).mergeBaseSha
  })

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  it('follows a moved line, flags a deleted one, resets viewed and carries notes over', async () => {
    const db = new CodeDuckyDb('rescan-checkpoint')
    try {
      const first = await scan()
      const lines = first.lines!
      const multiplyLine = lines.findIndex((entry) => entry.text.includes('item.quantity')) + 1
      const equalityLine = lines.findIndex((entry) => entry.text.includes('== 0')) + 1
      expect([multiplyLine, equalityLine]).toEqual([8, 13])

      const start = { repoId: 'r1', branch: 'feature/quantity', headSha: git(repo, 'rev-parse', 'HEAD'), baseSha }
      const sessionId = await startOrResumeSession(db, start)
      const moving = await addNote(db, {
        sessionId,
        path: PATH,
        anchor: createAnchor(lines, multiplyLine, 'new'),
        body: 'Quantity could be **undefined** for legacy items.',
        severity: 'issue',
      })
      const deleted = await addNote(db, {
        sessionId,
        path: PATH,
        anchor: createAnchor(lines, equalityLine, 'new'),
        body: 'Use `===`.',
        severity: 'nit',
      })
      const view = { sessionId, path: PATH, contentHash: contentHash(first.change), viewed: true }
      expect(isViewed(view, contentHash(first.change))).toBe(true)

      write(`import { log } from './log'\n\n${readFileSync(join(repo, PATH), 'utf8')}`)
      const second = await scan()
      await applyReanchoring(db, reanchorNotes(await db.notes.toArray(), () => second.lines))
      expect((await db.notes.get(moving))!.anchor.line).toBe(multiplyLine + 2)
      expect((await db.notes.get(deleted))!.anchor.line).toBe(equalityLine + 2)
      expect(isViewed(view, contentHash(second.change))).toBe(false)

      write(readFileSync(join(repo, PATH), 'utf8').replace('  return items.length == 0\n', '  return !items.length\n'))
      const third = await scan()
      await applyReanchoring(db, reanchorNotes(await db.notes.toArray(), () => third.lines))
      expect(await db.notes.get(moving)).toMatchObject({ anchorLost: false, anchor: { line: multiplyLine + 2 } })
      expect(await db.notes.get(deleted)).toMatchObject({ anchorLost: true, anchor: { line: equalityLine + 2 } })

      git(repo, 'commit', '--quiet', '-am', 'wip')
      write(`// header\n${readFileSync(join(repo, PATH), 'utf8')}`)
      const nextSession = await startNewSession(db, { ...start, headSha: git(repo, 'rev-parse', 'HEAD') })
      const carried = await db.notes.where({ sessionId: nextSession }).toArray()
      expect(carried.map((note) => note.carriedFrom).sort()).toEqual([moving, deleted].sort())
      const fourth = await scan()
      await applyReanchoring(db, reanchorNotes(carried, () => fourth.lines))
      const reanchored = await db.notes.where({ sessionId: nextSession }).toArray()
      expect(reanchored.find((note) => note.carriedFrom === moving)).toMatchObject({
        anchorLost: false,
        anchor: { line: multiplyLine + 3 },
      })
      expect(reanchored.find((note) => note.carriedFrom === deleted)?.anchorLost).toBe(true)

      const session = (await db.sessions.get(nextSession))!
      const report = buildReport({
        repoName: 'me/cart',
        baseBranch: 'main',
        session,
        files: [{ path: PATH, viewed: false }],
        notes: reanchored,
        checklists: [],
      })
      console.info(`\n${report}`)
      expect(report).toContain('- Notes: 2 notes (2 open, 1 possibly resolved); 1 issue, 1 nit')
      expect(report).toContain(`> ${multiplyLine + 3} |   for (const item of items) sum += item.price * item.quantity`)
      expect(report).toContain('**nit** · open, possibly resolved · last seen at line 15')
    } finally {
      await db.delete()
    }
  })
})
