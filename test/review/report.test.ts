import { describe, expect, it } from 'vitest'
import type { Note, Session } from '../../src/db/schema'
import { buildReport, noteExcerpt, reportFileName } from '../../src/review/report'

const session: Session = {
  id: 's7',
  repoId: 'r1',
  branch: 'feature/notes',
  headSha: 'abcdef1234567890',
  baseSha: '1234567abcdef',
  baseSource: 'local',
  startedAt: Date.UTC(2026, 9, 3, 14, 5),
  status: 'active',
}

const note = (overrides: Partial<Note>): Note => ({
  id: 'n1',
  sessionId: 's7',
  path: 'src/a.ts',
  anchor: { line: 12, side: 'new', text: 'const x = 1', before: ['// a', '// b'], after: ['export { x }'] },
  body: 'Rename **x**.',
  severity: 'issue',
  status: 'open',
  source: 'me',
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

describe('report', () => {
  it('renders an excerpt with the anchored line marked', () => {
    expect(noteExcerpt(note({}))).toBe(['  10 | // a', '  11 | // b', '> 12 | const x = 1', '  13 | export { x }'].join('\n'))
  })

  it('builds summary, checklist state and notes grouped by file', () => {
    const markdown = buildReport({
      repoName: 'me/repo',
      baseBranch: 'main',
      session,
      files: [
        { path: 'src/a.ts', viewed: true },
        { path: 'src/b.ts', viewed: false },
      ],
      checklists: [{ title: 'Before push', items: [{ text: 'Tests pass', checked: true }, { text: 'No logs', checked: false }] }],
      notes: [
        note({ id: 'n2', path: 'src/b.ts', severity: 'nit', status: 'resolved', body: 'Typo' }),
        note({ id: 'n1' }),
        note({ id: 'n3', severity: 'blocker', anchorLost: true, body: 'Null check', anchor: { line: 3, side: 'old', text: 'if (x) {', before: [], after: [] } }),
      ],
    })
    expect(markdown).toBe(
      [
        '# Review: me/repo · feature/notes',
        '',
        '- Branch: `feature/notes` against `origin/main`',
        '- Head: `abcdef1`, merge base `1234567`',
        '- Started: 2026-10-03 14:05 UTC',
        '- Files: 2 files changed, 1 of 2 viewed',
        '- Notes: 3 notes (2 open, 1 resolved, 1 possibly resolved); 1 blocker, 1 issue, 1 nit',
        '',
        '## Checklists',
        '',
        '### Before push (1/2)',
        '',
        '- [x] Tests pass',
        '- [ ] No logs',
        '',
        '## Notes',
        '',
        '### `src/a.ts`',
        '',
        '**blocker** · open, possibly resolved · last seen at line 3',
        '',
        'Null check',
        '',
        '```',
        '> 3 | if (x) {',
        '```',
        '',
        '**issue** · open · line 12',
        '',
        'Rename **x**.',
        '',
        '```',
        '  10 | // a',
        '  11 | // b',
        '> 12 | const x = 1',
        '  13 | export { x }',
        '```',
        '',
        '### `src/b.ts`',
        '',
        '**nit** · resolved · line 12',
        '',
        'Typo',
        '',
        '```',
        '  10 | // a',
        '  11 | // b',
        '> 12 | const x = 1',
        '  13 | export { x }',
        '```',
        '',
      ].join('\n'),
    )
  })

  it('lengthens the fence when the code contains backticks', () => {
    const markdown = buildReport({
      repoName: 'r',
      baseBranch: 'main',
      session,
      checklists: [],
      notes: [note({ anchor: { line: 1, side: 'new', text: 'const s = ```', before: [], after: [] } })],
    })
    expect(markdown).toContain('````\n> 1 | const s = ```\n````')
    expect(markdown).not.toContain('## Checklists')
    expect(markdown).not.toContain('- Files:')
  })

  it('suggests a safe file name', () => {
    expect(reportFileName('me/repo', session)).toBe('review-me-repo-feature-notes-2026-10-03.md')
  })
})
