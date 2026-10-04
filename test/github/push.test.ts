import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { CodeDuckyDb } from '../../src/db/db'
import { addNote } from '../../src/db/notes'
import type { Note, NoteSeverity } from '../../src/db/schema'
import { createGitHubClient } from '../../src/github/client'
import { commentIdsByNote, pendingReview, placeNotes, reviewBody } from '../../src/github/push'
import { preparePush, pushErrorHint, pushPendingReview } from '../../src/github/pushReview'
import type { PullFile } from '../../src/github/types'
import { GitHubError } from '../../src/github/errors'
import { createAnchor } from '../../src/review/anchor'
import { numberLines, type NumberedLine } from '../../src/review/lines'
import { patchSideLines } from '../../src/review/patch'
import { fixture, fixtureText, mockFetch } from './mockFetch'

const HEAD = '118bade96cd67e73abb7a355f5fc5f6a846805b8'
const TLS = 'server/src/boot/tls.ts'
const ref = { owner: 'charlesabarnes', name: 'gangway' }

interface RawFile {
  filename: string
  status: PullFile['status']
  patch?: string
}
const prFiles: PullFile[] = fixture<RawFile[]>('pull-files.json').map((file) => ({
  path: file.filename,
  previousPath: null,
  status: file.status,
  patch: file.patch ?? null,
}))
const tlsPatch = prFiles.find((file) => file.path === TLS)!.patch!
const tlsHead = numberLines(fixtureText('tls-head.ts.txt'))

const lineOf = (lines: NumberedLine[], text: string) => lines.find((entry) => entry.text.startsWith(text))!.line

let nextId = 1
function note(path: string, lines: NumberedLine[], line: number, extra: Partial<Note> = {}, side: 'old' | 'new' = 'new', endLine = line): Note {
  return {
    id: String(nextId++),
    sessionId: 's1',
    path,
    anchor: createAnchor(lines, line, side, endLine),
    body: 'Check this',
    severity: 'issue',
    status: 'open',
    source: 'me',
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }
}

describe('placeNotes', () => {
  it('places a note on an added line at the same line on the RIGHT side', () => {
    const line = lineOf(tlsHead, 'export function dnsProvider')
    const n = note(TLS, tlsHead, line)
    const { placed, unplaced } = placeNotes([n], prFiles)
    expect(unplaced).toEqual([])
    expect(placed).toEqual([
      { note: n, exact: true, comment: { path: TLS, line, side: 'RIGHT', body: '**issue:** Check this' } },
    ])
  })

  it('re-anchors notes from a local file that has moved on from the PR head', () => {
    const local = numberLines(['// local 1', '// local 2', '// local 3', ...tlsHead.map((entry) => entry.text)].join('\n'))
    const prLine = lineOf(tlsHead, '  const acmeDnsUrl')
    const n = note(TLS, local, prLine + 3)
    const { placed } = placeNotes([n], prFiles)
    expect(placed[0]?.comment).toMatchObject({ line: prLine, side: 'RIGHT' })
  })

  it('maps base-side notes onto the LEFT side', () => {
    const left = patchSideLines(tlsPatch, 'LEFT')
    const removed = lineOf(left, 'function dnsProvider')
    const n = note(TLS, left, removed, {}, 'old')
    expect(placeNotes([n], prFiles).placed[0]?.comment).toMatchObject({ line: removed, side: 'LEFT' })
  })

  it('reports notes that cannot be placed, with a reason', () => {
    const outside = note(TLS, tlsHead, lineOf(tlsHead, '      return acmeCertificates(d);'))
    const otherFile = note('README.md', numberLines('# Gangway\n'), 1)
    const binary = note('logo.png', numberLines('x\n'), 1)
    const files = [...prFiles, { path: 'logo.png', previousPath: null, status: 'added' as const, patch: null }]
    const { placed, unplaced } = placeNotes([outside, otherFile, binary], files)
    expect(placed).toEqual([])
    expect(Object.fromEntries(unplaced.map((entry) => [entry.note.path, entry.reason]))).toEqual({
      'README.md': 'File is not changed in the pull request',
      'logo.png': 'GitHub shows no diff for this file (binary or too large)',
      [TLS]: 'Line is not in the pull request diff',
    })
  })
})

describe('placing ranges', () => {
  const start = lineOf(tlsHead, 'export function dnsProvider')

  it('places a range as a multi-line comment from start_line to line', () => {
    const n = note(TLS, tlsHead, start, {}, 'new', start + 2)
    const { placed, unplaced } = placeNotes([n], prFiles)
    expect(unplaced).toEqual([])
    expect(placed[0]).toMatchObject({
      exact: true,
      comment: { path: TLS, startLine: start, startSide: 'RIGHT', line: start + 2, side: 'RIGHT' },
    })
  })

  it('moves both ends with local edits', () => {
    const local = numberLines(['// local 1', '// local 2', ...tlsHead.map((entry) => entry.text)].join('\n'))
    const n = note(TLS, local, start + 2, {}, 'new', start + 4)
    expect(placeNotes([n], prFiles).placed[0]?.comment).toMatchObject({ startLine: start, line: start + 2 })
  })

  it('leaves a range that is not inside one hunk for the review body', () => {
    const outside = lineOf(tlsHead, '      return acmeCertificates(d);')
    const n = note(TLS, tlsHead, outside, {}, 'new', start)
    const { placed, unplaced } = placeNotes([n], prFiles)
    expect(placed).toEqual([])
    expect(unplaced).toEqual([{ note: n, reason: 'Lines are not all in one hunk of the pull request diff' }])
    expect(reviewBody([n])).toContain(`\`${TLS}\`, lines ${outside}–${start}:`)
  })
})

describe('review payload', () => {
  it('lists unplaced notes in the body with fenced excerpts', () => {
    const n = note(TLS, tlsHead, lineOf(tlsHead, '      return acmeCertificates(d);'), {
      body: 'Is ```this``` right?\nSecond line',
      severity: 'nit' as NoteSeverity,
    })
    const body = reviewBody([n])
    expect(body.split('\n').slice(0, 6)).toEqual([
      'Notes that do not map onto the diff:',
      '',
      `- **nit** in \`${TLS}\`, line ${n.anchor.line}:`,
      '',
      '  Is ```this``` right?',
      '  Second line',
    ])
    expect(body).toContain(`  > ${n.anchor.line} |       return acmeCertificates(d);`)
    expect(body).toMatch(/\n {2}```\n/)
    expect(reviewBody([])).toBe('')
  })

  it('builds a pending review against the PR head', () => {
    const n = note(TLS, tlsHead, lineOf(tlsHead, 'export function dnsProvider'))
    const { placed } = placeNotes([n], prFiles)
    expect(pendingReview(HEAD, placed, [])).toEqual({ commitId: HEAD, body: '', comments: [placed[0]!.comment] })
  })

  it('pairs created comments with their notes', () => {
    const a = note(TLS, tlsHead, lineOf(tlsHead, 'export function dnsProvider'))
    const b = note(TLS, tlsHead, lineOf(tlsHead, '  const acmeDnsUrl'), { body: 'Other' })
    const { placed } = placeNotes([a, b], prFiles)
    const comments = placed
      .map((entry, i) => ({ id: 500 + i, path: entry.comment.path, line: entry.comment.line, side: entry.comment.side, body: entry.comment.body }))
      .reverse()
    expect(commentIdsByNote(placed, comments)).toEqual(new Map([[a.id!, 500], [b.id!, 501]]))
  })
})

describe('pushing a pending review', () => {
  const opened: CodeDuckyDb[] = []
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.delete()))
  })

  it('finds the PR, creates the review and links the notes', async () => {
    const db = new CodeDuckyDb('push')
    opened.push(db)
    const inline = await addNote(db, {
      sessionId: 's7',
      path: TLS,
      anchor: createAnchor(tlsHead, lineOf(tlsHead, 'export function dnsProvider'), 'new'),
      body: 'Exported only for tests?',
      severity: 'suggestion',
    })
    const outside = await addNote(db, {
      sessionId: 's7',
      path: TLS,
      anchor: createAnchor(tlsHead, lineOf(tlsHead, '      return acmeCertificates(d);'), 'new'),
      body: 'Unrelated',
      severity: 'nit',
    })
    const rangeStart = lineOf(tlsHead, '  const acmeDnsUrl')
    const range = await addNote(db, {
      sessionId: 's7',
      path: TLS,
      anchor: createAnchor(tlsHead, rangeStart, 'new', rangeStart + 1),
      body: 'Both of these',
      severity: 'issue',
    })
    const resolved = await addNote(db, {
      sessionId: 's7',
      path: TLS,
      anchor: createAnchor(tlsHead, 4, 'new'),
      body: 'Done already',
      severity: 'nit',
    })
    await db.notes.update(resolved, { status: 'resolved' })

    const { fetch, calls } = mockFetch([
      { match: /\/pulls\?/, body: fixture('pulls-by-head.json') },
      { match: /\/pulls\/48\/files/, body: fixture('pull-files.json') },
      {
        method: 'POST',
        match: /\/pulls\/48\/reviews$/,
        body: { id: 3141, state: 'PENDING', html_url: 'https://github.com/charlesabarnes/gangway/pull/48#pullrequestreview-3141' },
      },
      {
        match: /\/pulls\/48\/reviews\/3141\/comments/,
        body: [{ id: 2718, path: TLS, line: 86, side: 'RIGHT', body: '**suggestion:** Exported only for tests?' }],
      },
    ])
    const gh = createGitHubClient({ token: 't', fetch })
    const localHead = 'f'.repeat(40)
    const lookup = await preparePush(gh, ref, 'feat/acme-dns', localHead, await db.notes.toArray())
    if (lookup.kind !== 'ready') throw new Error('expected a PR')
    const { preview } = lookup
    expect(preview.pr.headSha).toBe(HEAD)
    expect(preview.localHead).not.toBe(preview.pr.headSha)
    expect(preview.placement.placed.map((entry) => entry.note.id)).toEqual([inline, range])
    expect(preview.placement.unplaced.map((entry) => entry.note.id)).toEqual([outside])

    const result = await pushPendingReview(db, gh, ref, preview.pr, {
      placed: preview.placement.placed,
      bodyNotes: preview.placement.unplaced.map((entry) => entry.note),
    })
    expect(result).toMatchObject({ review: { id: 3141 }, linked: 1 })

    const post = calls.find((call) => call.method === 'POST')!
    expect(post.body).toMatchObject({
      commit_id: HEAD,
      comments: [
        { path: TLS, side: 'RIGHT', body: '**suggestion:** Exported only for tests?' },
        { path: TLS, start_line: rangeStart, start_side: 'RIGHT', line: rangeStart + 1, side: 'RIGHT', body: '**issue:** Both of these' },
      ],
    })
    expect((post.body as { comments: object[] }).comments[0]).not.toHaveProperty('start_line')
    expect((post.body as { body: string }).body).toContain('Unrelated')
    expect(post.body).not.toHaveProperty('event')
    expect(calls.every((call) => call.method === 'GET' || call.url.pathname.endsWith('/pulls/48/reviews'))).toBe(true)

    expect((await db.notes.get(inline))?.github).toEqual({ reviewId: 3141, commentId: 2718 })
    expect((await db.notes.get(outside))?.github).toEqual({ reviewId: 3141 })
    expect((await db.notes.get(resolved))?.github).toBeUndefined()
  })

  it('reports when the branch has no open PR', async () => {
    const { fetch } = mockFetch([{ match: /\/pulls\?/, body: [] }])
    const gh = createGitHubClient({ token: 't', fetch })
    expect(await preparePush(gh, ref, 'lonely', HEAD, [])).toEqual({ kind: 'no-pr' })
  })

  it('explains an existing pending review', () => {
    const error = new GitHubError('invalid', 422, 'GitHub rejected the request (422). GitHub said: User can only have one pending review per pull request')
    expect(pushErrorHint(error)).toMatch(/already have a pending review/)
    expect(pushErrorHint(new Error('other'))).toBeNull()
  })
})
