import type { SaveResult } from '../db/suggestions'
import type { FileChange, FileContents, FileSide } from '../git/types'
import { sideLines } from '../review/lines'
import { chunkFile, DEFAULT_LIMITS, type ChunkLimits } from './chunk'
import type { ChunkReviewer } from './client'
import { ClaudeOutputError, type ClaudeFailure } from './errors'
import { toSuggestions, type SuggestionDraft } from './findings'
import { addUsage, EMPTY_TOTALS, type UsageTotals } from './pricing'
import type { Finding } from './types'

export type FileState = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'

export interface FileProgress {
  path: string
  state: FileState
  chunks: number
  chunksDone: number
  added: number
  duplicates: number
  unanchored: number
  invalid: number
  message?: string
}

export type PassStatus = 'running' | 'done' | 'cancelled' | 'failed'

export interface PassProgress {
  status: PassStatus
  files: FileProgress[]
  usage: UsageTotals
  /** Set when a fatal error (bad key, unknown model) stopped the pass. */
  error?: string
}

export interface PassDeps {
  loadContents: (file: FileChange) => Promise<FileContents>
  review: ChunkReviewer
  save: (drafts: SuggestionDraft[]) => Promise<SaveResult>
  describe: (error: unknown) => ClaudeFailure
}

export interface PassOptions {
  signal: AbortSignal
  onProgress: (progress: PassProgress) => void
  concurrency?: number
  limits?: ChunkLimits
  usage?: UsageTotals
}

export const DEFAULT_CONCURRENCY = 3

const textOf = (side: FileSide | null) => (side?.kind === 'text' ? side.text : null)
const unreadable = (side: FileSide | null) => side !== null && side.kind !== 'text'

function initialFile(path: string): FileProgress {
  return { path, state: 'queued', chunks: 0, chunksDone: 0, added: 0, duplicates: 0, unanchored: 0, invalid: 0 }
}

export async function runPass(files: readonly FileChange[], deps: PassDeps, options: PassOptions): Promise<PassProgress> {
  const { signal, onProgress, concurrency = DEFAULT_CONCURRENCY, limits = DEFAULT_LIMITS } = options
  const stop = new AbortController()
  const abort = () => stop.abort()
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })

  const state: PassProgress = { status: 'running', files: files.map((file) => initialFile(file.path)), usage: options.usage ?? EMPTY_TOTALS }
  const emit = () => onProgress({ ...state, files: state.files.map((file) => ({ ...file })) })
  const update = (index: number, changes: Partial<FileProgress>) => {
    state.files[index] = { ...state.files[index]!, ...changes }
    emit()
  }

  const reviewFile = async (index: number) => {
    const file = files[index]!
    if (file.status === 'deleted') return update(index, { state: 'skipped', message: 'Deleted file' })
    update(index, { state: 'running' })
    const findings: Finding[] = []
    let invalid = 0
    let lines: ReturnType<typeof linesOf> | null = null
    try {
      const contents = await deps.loadContents(file)
      if (unreadable(contents.old) || unreadable(contents.new)) {
        return update(index, { state: 'skipped', message: 'Binary or too large' })
      }
      lines = linesOf(contents)
      const chunks = chunkFile({ path: file.path, status: file.status, oldText: textOf(contents.old), newText: textOf(contents.new) }, limits)
      if (chunks.length === 0) return update(index, { state: 'skipped', message: 'No line changes' })
      update(index, { chunks: chunks.length })
      for (const chunk of chunks) {
        stop.signal.throwIfAborted()
        try {
          const result = await deps.review(chunk, stop.signal)
          findings.push(...result.findings)
          invalid += result.invalid
          state.usage = addUsage(state.usage, result.usage)
        } catch (error) {
          if (error instanceof ClaudeOutputError) state.usage = addUsage(state.usage, error.usage)
          throw error
        }
        update(index, { chunksDone: state.files[index]!.chunksDone + 1, invalid })
      }
      const saved = await saveFindings(findings, lines)
      update(index, { state: 'done', ...saved })
    } catch (error) {
      const partial = lines && findings.length > 0 ? saveFindings(findings, lines) : null
      const saved = (await partial?.catch(() => null)) ?? {}
      const failure = deps.describe(error)
      if (stop.signal.aborted || failure.kind === 'cancelled') return update(index, { state: 'cancelled', ...saved })
      if (failure.fatal && !state.error) {
        state.error = failure.message
        stop.abort()
      }
      update(index, { state: 'failed', message: failure.message, ...saved })
    }
  }

  const saveFindings = async (findings: Finding[], lines: ReturnType<typeof linesOf>) => {
    const { drafts, unanchored } = toSuggestions(findings, lines)
    const { added, duplicates } = await deps.save(drafts)
    return { added, duplicates, unanchored }
  }

  emit()
  let next = 0
  const worker = async () => {
    while (next < files.length) {
      const index = next++
      if (stop.signal.aborted) {
        update(index, { state: 'cancelled' })
        continue
      }
      await reviewFile(index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, files.length)) }, worker))
  signal.removeEventListener('abort', abort)

  state.status = state.error ? 'failed' : signal.aborted ? 'cancelled' : 'done'
  emit()
  return { ...state, files: state.files.map((file) => ({ ...file })) }
}

function linesOf(contents: FileContents) {
  return { old: sideLines(contents.old), new: sideLines(contents.new) }
}
