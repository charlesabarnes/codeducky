import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { ClaudeOutputError, describeClaudeError } from '../../src/claude/errors'
import type { SuggestionDraft } from '../../src/claude/findings'
import { runPass, type PassDeps, type PassProgress } from '../../src/claude/pass'
import { addUsage, EMPTY_TOTALS, entryCost, formatCost } from '../../src/claude/pricing'
import type { ChunkResult, ReviewChunk, UsageEntry } from '../../src/claude/types'
import type { FileChange, FileContents } from '../../src/git/types'

const change = (path: string, status: FileChange['status'] = 'modified'): FileChange => ({ path, status, oldOid: 'a', newOid: 'b' })
const text = (value: string) => ({ kind: 'text' as const, text: value, size: value.length })
const usage = (inputTokens = 1000, outputTokens = 100): UsageEntry => ({
  model: 'claude-opus-5-5',
  inputTokens,
  outputTokens,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
})

function harness(review: (chunk: ReviewChunk, signal: AbortSignal) => Promise<ChunkResult>, contents?: (file: FileChange) => FileContents) {
  const saved: SuggestionDraft[][] = []
  const progress: PassProgress[] = []
  const deps: PassDeps = {
    loadContents: async (file) => contents?.(file) ?? { path: file.path, old: text('a\nb\n'), new: text('a\nB\n') },
    review,
    save: async (drafts) => {
      saved.push(drafts)
      return { added: drafts.length, duplicates: 0 }
    },
    describe: (error) => describeClaudeError(error, 'claude-opus-5-5'),
  }
  return { deps, saved, progress, onProgress: (next: PassProgress) => progress.push(next) }
}

const findingOn = (chunk: ReviewChunk): ChunkResult => ({
  findings: [{ path: chunk.path, side: 'new', line: 2, lineText: 'B', severity: 'issue', title: `Check ${chunk.path}`, body: 'Body' }],
  invalid: 0,
  usage: [usage()],
})

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

describe('runPass', () => {
  it('reviews files a few at a time, saves anchored suggestions and totals usage', async () => {
    let active = 0
    let peak = 0
    const { deps, saved, progress, onProgress } = harness(async (chunk) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return findingOn(chunk)
    })
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map((path) => change(path))
    const result = await runPass(files, deps, { signal: new AbortController().signal, onProgress, concurrency: 2 })

    expect(peak).toBe(2)
    expect(result.status).toBe('done')
    expect(result.files.every((file) => file.state === 'done' && file.added === 1 && file.chunksDone === 1)).toBe(true)
    expect(saved.flat().map((draft) => [draft.path, draft.anchor.line, draft.anchor.text])).toContainEqual(['c.ts', 2, 'B'])
    expect(result.usage).toMatchObject({ requests: 5, inputTokens: 5000, outputTokens: 500 })
    expect(result.usage.cost).toBeCloseTo((5000 * 4 + 500 * 20) / 1_000_000)
    expect(progress[0]!.files.every((file) => file.state === 'queued')).toBe(true)
    expect(progress.some((snapshot) => snapshot.files.some((file) => file.state === 'running'))).toBe(true)
  })

  it('skips deleted, binary and unchanged files without calling the API', async () => {
    const calls: string[] = []
    const { deps, onProgress } = harness(
      async (chunk) => {
        calls.push(chunk.path)
        return findingOn(chunk)
      },
      (file) =>
        file.path === 'logo.png'
          ? { path: file.path, old: { kind: 'binary', size: 10 }, new: { kind: 'binary', size: 12 } }
          : file.path === 'mode.sh'
            ? { path: file.path, old: text('x\n'), new: text('x\n') }
            : { path: file.path, old: text('a\n'), new: text('b\n') },
    )
    const result = await runPass([change('gone.ts', 'deleted'), change('logo.png'), change('mode.sh'), change('ok.ts')], deps, {
      signal: new AbortController().signal,
      onProgress,
    })
    expect(calls).toEqual(['ok.ts'])
    expect(result.files.map((file) => [file.path, file.state, file.message])).toEqual([
      ['gone.ts', 'skipped', 'Deleted file'],
      ['logo.png', 'skipped', 'Binary or too large'],
      ['mode.sh', 'skipped', 'No line changes'],
      ['ok.ts', 'done', undefined],
    ])
  })

  it('stops the whole pass on a fatal error such as a bad key', async () => {
    const authError = new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error' } }, 'bad key', new Headers())
    const { deps, onProgress } = harness(async (chunk, signal) => {
      if (chunk.path === 'a.ts') throw authError
      await new Promise((resolve) => setTimeout(resolve, 20))
      signal.throwIfAborted()
      return findingOn(chunk)
    })
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((path) => change(path))
    const result = await runPass(files, deps, { signal: new AbortController().signal, onProgress, concurrency: 2 })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('API key was rejected')
    expect(result.files.map((file) => file.state)).toEqual(['failed', 'cancelled', 'cancelled', 'cancelled'])
  })

  it('keeps going past per-file failures, counting tokens spent on unusable output', async () => {
    const refusal = new ClaudeOutputError('refusal', 'Claude declined to review this part of the file.')
    refusal.usage = [usage(400, 0)]
    const { deps, onProgress } = harness(async (chunk) => {
      if (chunk.path === 'b.ts') throw refusal
      return findingOn(chunk)
    })
    const result = await runPass([change('a.ts'), change('b.ts'), change('c.ts')], deps, { signal: new AbortController().signal, onProgress })
    expect(result.status).toBe('done')
    expect(result.files.map((file) => file.state)).toEqual(['done', 'failed', 'done'])
    expect(result.files[1]!.message).toContain('declined')
    expect(result.usage.inputTokens).toBe(2400)
  })

  it('saves findings from earlier chunks when a later chunk fails', async () => {
    const big = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`)
    const edited = big.map((line, i) => (i === 10 || i === 250 ? `${line} edited` : line))
    let calls = 0
    const { deps, saved, onProgress } = harness(
      async (chunk) => {
        calls++
        if (chunk.part === 2) throw new ClaudeOutputError('truncated', 'The response hit the output limit before it finished.')
        return { findings: [{ path: chunk.path, side: 'new', line: 11, lineText: 'line 11 edited', severity: 'issue', title: 'T', body: '' }], invalid: 0, usage: [usage()] }
      },
      (file) => ({ path: file.path, old: text(`${big.join('\n')}\n`), new: text(`${edited.join('\n')}\n`) }),
    )
    const result = await runPass([change('big.ts')], deps, {
      signal: new AbortController().signal,
      onProgress,
      limits: { wholeFileLines: 100, context: 3, maxLines: 8 },
    })
    expect(calls).toBe(2)
    expect(result.files[0]).toMatchObject({ state: 'failed', chunks: 2, chunksDone: 1, added: 1 })
    expect(saved.flat()[0]!.anchor.line).toBe(11)
  })

  it('cancels running and queued files', async () => {
    const gate = deferred()
    const controller = new AbortController()
    const { deps, onProgress } = harness(async (chunk, signal) => {
      gate.resolve()
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()), { once: true })
        setTimeout(resolve, 1000)
      })
      return findingOn(chunk)
    })
    const running = runPass([change('a.ts'), change('b.ts'), change('c.ts')], deps, { signal: controller.signal, onProgress, concurrency: 1 })
    await gate.promise
    controller.abort()
    const result = await running
    expect(result.status).toBe('cancelled')
    expect(result.files.map((file) => file.state)).toEqual(['cancelled', 'cancelled', 'cancelled'])
    expect(result.error).toBeUndefined()
  })

  it('carries usage over from an earlier run when retrying', async () => {
    const { deps, onProgress } = harness(async (chunk) => findingOn(chunk))
    const earlier = addUsage(EMPTY_TOTALS, [usage(500, 50)])
    const result = await runPass([change('a.ts')], deps, { signal: new AbortController().signal, onProgress, usage: earlier })
    expect(result.usage).toMatchObject({ requests: 2, inputTokens: 1500, outputTokens: 150 })
  })
})

describe('pricing', () => {
  it('prices cache reads and writes, and flags unknown models', () => {
    expect(entryCost({ model: 'claude-opus-5-5', inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(24.2)
    expect(entryCost({ model: 'claude-sonnet-4-6', inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000 })).toBeCloseTo(3.75 + 0.3)
    const totals = addUsage(EMPTY_TOTALS, [{ ...usage(), model: 'claude-mystery' }])
    expect(totals.cost).toBeNull()
    expect(totals.unpricedModels).toEqual(['claude-mystery'])
    expect(formatCost(null)).toBe('unknown')
    expect(formatCost(0.004)).toBe('< $0.01')
    expect(formatCost(1.234)).toBe('$1.23')
  })
})
