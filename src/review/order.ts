import type { FileChange, FileStats } from '../git/types'

export type FileOrder = 'folders' | 'risk'

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', '__specs__'])
/** Directory names that differ between a source tree and its test mirror. */
const MIRROR_DIRS = new Set([...TEST_DIRS, 'src', 'main', 'lib', 'java', 'kotlin', 'scala', 'app'])

const segments = (path: string) => path.split('/')
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

function stripExtension(name: string): string {
  const dot = name.indexOf('.', 1)
  return dot > 0 ? name.slice(0, dot) : name
}

const TEST_NAME = [
  /^(.+)\.(?:test|spec|tests|specs)\.[^/]+$/i,
  /^(.+?)(?:Tests?|Spec|IT)\.(?:kt|kts|java|scala|groovy|cs|swift)$/,
  /^(.+)_test\.(?:go|py|rb|exs?|dart|rs)$/,
  /^test_(.+)\.py$/,
]

/** For a test file, the stem of the file it tests (`hunks` for `hunks.test.ts`); null when not a test. */
export function testSubject(path: string): string | null {
  const name = basename(path)
  for (const pattern of TEST_NAME) {
    const match = pattern.exec(name)
    if (match?.[1]) return stripExtension(match[1]).toLowerCase()
  }
  const dirs = segments(path).slice(0, -1)
  if (dirs.some((dir) => TEST_DIRS.has(dir.toLowerCase()))) return stripExtension(name).toLowerCase()
  return null
}

export const isTestPath = (path: string) => testSubject(path) !== null

/** Directories with the test/source mirror names removed, innermost first. */
const mirrorDirs = (path: string) =>
  segments(path)
    .slice(0, -1)
    .filter((dir) => !MIRROR_DIRS.has(dir.toLowerCase()))
    .reverse()

function affinity(test: string, source: string): number {
  const a = mirrorDirs(test)
  const b = mirrorDirs(source)
  let shared = 0
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++
  return shared * 2 - Math.abs(a.length - b.length) * 0.1
}

/** Maps each test path to the changed source file it most likely tests. */
export function pairTests(paths: readonly string[]): Map<string, string> {
  const sources = new Map<string, string[]>()
  for (const path of paths) {
    if (isTestPath(path)) continue
    const stem = stripExtension(basename(path)).toLowerCase()
    sources.set(stem, [...(sources.get(stem) ?? []), path])
  }
  const pairs = new Map<string, string>()
  for (const path of paths) {
    const subject = testSubject(path)
    const candidates = subject === null ? undefined : sources.get(subject)
    if (!candidates?.length) continue
    let best = candidates[0]!
    for (const candidate of candidates) if (affinity(path, candidate) > affinity(path, best)) best = candidate
    pairs.set(path, best)
  }
  return pairs
}

/** File-tree order: compared segment by segment, folders before files at each level. */
export function comparePaths(a: string, b: string): number {
  const left = segments(a)
  const right = segments(b)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] === right[i]) continue
    // Folders before files at each level, as in a file tree.
    const leftIsFile = i === left.length - 1
    const rightIsFile = i === right.length - 1
    if (leftIsFile !== rightIsFile) return leftIsFile ? 1 : -1
    return left[i]! < right[i]! ? -1 : 1
  }
  return left.length - right.length
}

/** Directory order, with each test right after the source file it tests. */
export function folderOrder<T extends { path: string }>(files: readonly T[]): T[] {
  const subjects = pairTests(files.map((file) => file.path))
  const keyOf = (file: T) => subjects.get(file.path) ?? file.path
  return [...files].sort((a, b) => {
    const byKey = comparePaths(keyOf(a), keyOf(b))
    if (byKey !== 0) return byKey
    const aTest = subjects.has(a.path)
    const bTest = subjects.has(b.path)
    if (aTest !== bTest) return aTest ? 1 : -1
    return comparePaths(a.path, b.path)
  })
}

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'gemfile.lock',
  'poetry.lock',
  'pipfile.lock',
  'uv.lock',
  'composer.lock',
  'go.sum',
  'flake.lock',
  'gradle.lockfile',
  'podfile.lock',
  'mix.lock',
  'pubspec.lock',
])

const SENSITIVE = /(^|[/._-])(auth\w*|oauth|login|session|passwords?|secrets?|tokens?|crypto|security|permissions?|acl|rbac|csrf|sanitiz\w*|migrations?|migrate)([/._-]|$)/i
const CONFIG = /(^|\/)(\.env[^/]*|[^/]*config[^/]*|settings\.[^/]+|dockerfile|[^/]*compose\.ya?ml|\.github\/workflows\/[^/]+|[^/]*\.tf|nginx\.conf|caddyfile)$/i

export const isLockfile = (path: string) => LOCKFILES.has(basename(path).toLowerCase())

export interface RiskInput {
  stats?: FileStats
  openNotes?: number
}

export interface Risk {
  score: number
  reasons: string[]
}

/** A rough review-risk score; higher reads first. Lockfiles always score lowest. */
export function riskOf(change: FileChange, { stats, openNotes = 0 }: RiskInput): Risk {
  const reasons: string[] = []
  if (isLockfile(change.path)) return { score: -1, reasons: ['lockfile'] }
  const lines = stats && 'additions' in stats ? stats.additions + stats.deletions : 0
  let score = Math.log2(1 + lines)
  if (lines >= 100) reasons.push(`${lines} lines changed`)
  if (change.status === 'added') {
    score += 2
    reasons.push('new file')
  }
  const paths = change.oldPath ? [change.path, change.oldPath] : [change.path]
  if (paths.some((path) => SENSITIVE.test(path))) {
    score += 6
    reasons.push('sensitive path')
  } else if (paths.some((path) => CONFIG.test(path))) {
    score += 3
    reasons.push('configuration')
  }
  if (change.status === 'deleted' && isTestPath(change.path)) {
    score += 5
    reasons.push('deleted test')
  }
  if (openNotes > 0) {
    score += Math.min(openNotes, 3) * 3
    reasons.push(`${openNotes} open ${openNotes === 1 ? 'note' : 'notes'}`)
  }
  return { score, reasons }
}

/** Highest risk first; ties keep directory order. */
export function riskOrder<T extends FileChange>(files: readonly T[], input: (file: T) => RiskInput): T[] {
  const folders = folderOrder(files)
  const position = new Map(folders.map((file, index) => [file, index]))
  const scores = new Map(files.map((file) => [file, riskOf(file, input(file)).score]))
  return [...files].sort((a, b) => scores.get(b)! - scores.get(a)! || position.get(a)! - position.get(b)!)
}

export function orderFiles<T extends FileChange>(files: readonly T[], order: FileOrder, input: (file: T) => RiskInput): T[] {
  return order === 'risk' ? riskOrder(files, input) : folderOrder(files)
}
