import { describe, expect, it } from 'vitest'
import { buildLines } from '../../src/diff/hunks'
import { parsePatchSet, patchSides } from '../../src/review/patchSet'

const gitDiff = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  ' import a',
  '-import b',
  '+import B',
  '+import c',
  ' ',
  '@@ -10,2 +11,2 @@ function run() {',
  '   start()',
  '-  stop()',
  '+  halt()',
  'diff --git a/docs/new file.md b/docs/new file.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/docs/new file.md',
  '@@ -0,0 +1,2 @@',
  '+# Title',
  '+body',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  'diff --git a/lib/before.ts b/lib/after.ts',
  'similarity index 90%',
  'rename from lib/before.ts',
  'rename to lib/after.ts',
  '--- a/lib/before.ts',
  '+++ b/lib/after.ts',
  '@@ -4,1 +4,1 @@',
  '-old name',
  '+new name',
  'diff --git a/logo.png b/logo.png',
  'index 4444444..5555555 100644',
  'Binary files a/logo.png and b/logo.png differ',
  'diff --git a/run.sh b/run.sh',
  'old mode 100644',
  'new mode 100755',
  '',
].join('\n')

describe('parsePatchSet', () => {
  it('splits git diff output into files with status, renames and counts', () => {
    const files = parsePatchSet(gitDiff)
    expect(files.map(({ path, status, oldPath, binary, additions, deletions }) => ({ path, status, oldPath, binary, additions, deletions }))).toEqual([
      { path: 'src/app.ts', status: 'modified', oldPath: undefined, binary: false, additions: 3, deletions: 2 },
      { path: 'docs/new file.md', status: 'added', oldPath: undefined, binary: false, additions: 2, deletions: 0 },
      { path: 'old.txt', status: 'deleted', oldPath: undefined, binary: false, additions: 0, deletions: 1 },
      { path: 'lib/after.ts', status: 'modified', oldPath: 'lib/before.ts', binary: false, additions: 1, deletions: 1 },
      { path: 'logo.png', status: 'modified', oldPath: undefined, binary: true, additions: 0, deletions: 0 },
    ])
    expect(files[0]!.hunks.split('\n')[0]).toBe('@@ -1,3 +1,4 @@')
  })

  it('reads a plain unified diff without git headers', () => {
    const files = parsePatchSet(['--- a.txt\t2026-01-01 10:00', '+++ a.txt\t2026-01-02 10:00', '@@ -1 +1 @@', '-x', '+y', '--- b.txt', '+++ b.txt', '@@ -2 +2 @@', '-p', '+q'].join('\n'))
    expect(files.map((file) => [file.path, file.additions, file.deletions])).toEqual([
      ['a.txt', 1, 1],
      ['b.txt', 1, 1],
    ])
  })

  it('skips format-patch mail, message and diffstat, and stops a hunk at its line counts', () => {
    const series = [
      'From 0123456789abcdef Mon Sep 17 00:00:00 2001',
      'From: Dev <dev@example.com>',
      'Subject: [PATCH 1/2] First',
      '',
      '--- a note in the message body',
      '---',
      ' a.ts | 2 +-',
      '',
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-one',
      '+two',
      '-- ',
      '2.45.0',
      '',
      'From fedcba9876543210 Mon Sep 17 00:00:00 2001',
      'Subject: [PATCH 2/2] Second',
      '---',
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -2 +2 @@',
      '-two',
      '+three',
      '\\ No newline at end of file',
      '-- ',
      '2.45.0',
    ].join('\n')
    const files = parsePatchSet(series)
    expect(files.map((file) => [file.path, file.additions, file.deletions])).toEqual([
      ['a.ts', 1, 1],
      ['(2) a.ts', 1, 1],
    ])
    expect(files[0]!.hunks).not.toContain('2.45.0')
  })

  it('handles CRLF patches and finds nothing in other text', () => {
    expect(parsePatchSet('--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n')[0]!.hunks).toBe('@@ -1 +1 @@\n-a\n+b')
    expect(parsePatchSet('just some notes\n- a list\n+ another')).toEqual([])
  })
})

describe('patchSides', () => {
  it('puts every known line at its real number and leaves the rest blank', () => {
    const [file] = parsePatchSet(gitDiff)
    const sides = patchSides(file!)
    const oldLines = sides.old!.split('\n')
    const newLines = sides.new!.split('\n')
    expect(oldLines.slice(0, 3)).toEqual(['import a', 'import b', ''])
    expect(oldLines[9]).toBe('  start()')
    expect(oldLines[10]).toBe('  stop()')
    expect(newLines[11]).toBe('  halt()')
    expect(newLines.slice(3, 10).every((line) => line === '')).toBe(true)
  })

  it('diffs back to exactly the patch, numbers included', () => {
    const [file] = parsePatchSet(gitDiff)
    const sides = patchSides(file!)
    const changed = buildLines(sides.old!, sides.new!).filter((line) => line.kind !== 'context')
    expect(changed).toEqual([
      { kind: 'del', text: 'import b', oldNo: 2, newNo: null },
      { kind: 'add', text: 'import B', oldNo: null, newNo: 2 },
      { kind: 'add', text: 'import c', oldNo: null, newNo: 3 },
      { kind: 'del', text: '  stop()', oldNo: 11, newNo: null },
      { kind: 'add', text: '  halt()', oldNo: null, newNo: 12 },
    ])
  })

  it('has no old side for an added file and no new side for a deleted one', () => {
    const [, added, deleted] = parsePatchSet(gitDiff)
    expect(patchSides(added!)).toEqual({ old: null, new: '# Title\nbody\n' })
    expect(patchSides(deleted!)).toEqual({ old: 'gone\n', new: null })
  })
})
