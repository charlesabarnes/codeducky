import type { ChangeStatus } from '../git/types'
import { patchDiffLines } from './patch'

/** One file of a unified diff or `git format-patch` file. */
export interface PatchFile {
  path: string
  /** Set for renames: the path on the old side. */
  oldPath?: string
  status: ChangeStatus
  binary: boolean
  /** The file's hunks, `@@` headers included, as `patchDiffLines` reads them. */
  hunks: string
  additions: number
  deletions: number
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
/** Sides are rebuilt line by line, so a hunk past this line would allocate that many blank lines. */
export const MAX_PATCH_LINE = 1_000_000

const tooFar = (line: number) => new Error(`The patch has a hunk at line ${line}; Code Ducky reads patches up to line ${MAX_PATCH_LINE.toLocaleString('en-US')}.`)
const NULL_PATH = '/dev/null'

/** A path from a `---`/`+++` line: no a/ or b/ prefix, no timestamp, unquoted. */
function headerPath(raw: string): string | null {
  let path = raw.replace(/\t.*$/, '').trim()
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1).replace(/\\(.)/g, '$1')
  if (path === NULL_PATH) return null
  return /^[ab]\//.test(path) ? path.slice(2) : path
}

/** `diff --git a/x b/y`: when both sides are the same path the split is unambiguous even with spaces in it. */
function gitHeaderPaths(rest: string): { oldPath: string; newPath: string } | null {
  if (!rest.startsWith('a/')) return null
  const half = (rest.length - 1) / 2
  if (Number.isInteger(half) && rest.slice(half, half + 3) === ' b/' && rest.slice(2, half) === rest.slice(half + 3)) {
    return { oldPath: rest.slice(2, half), newPath: rest.slice(half + 3) }
  }
  const split = rest.lastIndexOf(' b/')
  return split > 0 ? { oldPath: rest.slice(2, split), newPath: rest.slice(split + 3) } : null
}

interface Draft {
  oldPath: string | null
  newPath: string | null
  added: boolean
  deleted: boolean
  binary: boolean
  hunks: string[]
}

const emptyDraft = (): Draft => ({ oldPath: null, newPath: null, added: false, deleted: false, binary: false, hunks: [] })

function finish(draft: Draft): Omit<PatchFile, 'additions' | 'deletions'> | null {
  const path = draft.newPath ?? draft.oldPath
  if (path === null) return null
  const status: ChangeStatus = draft.added || draft.oldPath === null ? 'added' : draft.deleted || draft.newPath === null ? 'deleted' : 'modified'
  const file: Omit<PatchFile, 'additions' | 'deletions'> = { path, status, binary: draft.binary, hunks: draft.hunks.join('\n') }
  if (status === 'modified' && draft.oldPath !== null && draft.oldPath !== path) file.oldPath = draft.oldPath
  return file
}

/**
 * Splits a patch into its files: `git diff` output, a plain unified diff, or a `git format-patch` series (mail
 * headers, commit message and diffstat are skipped). Hunks are read by their line counts, so a format-patch
 * signature ("-- ") after the last hunk is not taken for a removed line. A path changed by several commits of a
 * series is listed once per commit, the later ones prefixed "(2) ", "(3) "…, since their line numbers differ.
 */
export function parsePatchSet(text: string): PatchFile[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const drafts: Draft[] = []
  let draft: Draft | null = null
  let oldLeft = 0
  let newLeft = 0
  const inHunk = () => oldLeft > 0 || newLeft > 0
  const start = () => {
    draft = emptyDraft()
    drafts.push(draft)
    return draft
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const current = draft as Draft | null
    if (current && inHunk()) {
      const marker = line.charAt(0)
      if (marker === '\\') {
        current.hunks.push(line)
        continue
      }
      if (marker === ' ' || line === '') {
        oldLeft--
        newLeft--
      } else if (marker === '-') oldLeft--
      else if (marker === '+') newLeft--
      else {
        oldLeft = newLeft = 0
        i--
        continue
      }
      current.hunks.push(line)
      continue
    }
    if (line.startsWith('diff --git ')) {
      const paths = gitHeaderPaths(line.slice('diff --git '.length))
      const next = start()
      if (paths) Object.assign(next, paths)
      continue
    }
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const target = current && current.hunks.length === 0 && !current.binary ? current : start()
      target.oldPath = headerPath(line.slice(4))
      target.newPath = headerPath(lines[i + 1]!.slice(4))
      if (target.oldPath === null) target.added = true
      if (target.newPath === null) target.deleted = true
      i++
      continue
    }
    if (!current) continue
    const hunk = HUNK.exec(line)
    if (hunk) {
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
      const end = Math.max(Number(hunk[1]) + oldLeft, Number(hunk[3]) + newLeft)
      if (end > MAX_PATCH_LINE) throw tooFar(end)
      current.hunks.push(line)
      continue
    }
    if (current.hunks.length > 0) continue
    if (line.startsWith('new file mode')) current.added = true
    else if (line.startsWith('deleted file mode')) current.deleted = true
    else if (line.startsWith('rename from ')) current.oldPath = line.slice('rename from '.length)
    else if (line.startsWith('rename to ')) current.newPath = line.slice('rename to '.length)
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') current.binary = true
  }

  const seen = new Map<string, number>()
  const files: PatchFile[] = []
  for (const each of drafts) {
    const file = finish(each)
    if (!file || (!file.binary && file.hunks === '' && file.oldPath === undefined && file.status === 'modified')) continue
    const count = (seen.get(file.path) ?? 0) + 1
    seen.set(file.path, count)
    let additions = 0
    let deletions = 0
    for (const diffLine of patchDiffLines(file.hunks)) {
      if (diffLine.kind === 'add') additions++
      else if (diffLine.kind === 'del') deletions++
    }
    files.push({ ...file, path: count > 1 ? `(${count}) ${file.path}` : file.path, additions, deletions })
  }
  return files
}

/**
 * Both sides of a file as far as its hunks show them. Lines outside the hunks are unknown and left blank, so
 * every known line keeps its real number and notes anchor where they would on the full file.
 */
export function patchSides(file: Pick<PatchFile, 'hunks' | 'status'>): { old: string | null; new: string | null } {
  const oldLines: string[] = []
  const newLines: string[] = []
  for (const line of patchDiffLines(file.hunks)) {
    const far = Math.max(line.oldNo ?? 0, line.newNo ?? 0)
    if (far > MAX_PATCH_LINE) throw tooFar(far)
    if (line.oldNo !== null) oldLines[line.oldNo - 1] = line.text
    if (line.newNo !== null) newLines[line.newNo - 1] = line.text
  }
  const join = (lines: string[]) => (lines.length === 0 ? '' : `${Array.from(lines, (line) => line ?? '').join('\n')}\n`)
  return {
    old: file.status === 'added' ? null : join(oldLines),
    new: file.status === 'deleted' ? null : join(newLines),
  }
}
