import { describe, expect, it } from 'vitest'
import { buildRequest, chunkReviewer, createClaudeClient } from '../../src/claude/client'
import { ClaudeOutputError, describeClaudeError } from '../../src/claude/errors'
import { parseFindings } from '../../src/claude/parse'
import { SYSTEM_PROMPT, systemPrompt, userPrompt } from '../../src/claude/prompt'
import type { ReviewChunk } from '../../src/claude/types'
import { errorReply, fakeFetch, streamReply } from '../support/fakeAnthropic'

const chunk: ReviewChunk = {
  path: 'src/cart.ts',
  status: 'modified',
  part: 1,
  parts: 1,
  wholeFile: true,
  diff: ' 1 1 | let sum = 0\n+  2 | console.log(sum)',
}

const finding = {
  path: 'src/cart.ts',
  side: 'new',
  line: 2,
  line_text: 'console.log(sum)',
  severity: 'suggestion',
  title: 'Leftover debug log',
  body: 'Remove the `console.log` before pushing.',
}

const reviewWith = (replies: (() => Response)[], model = 'claude-opus-5-5', maxRetries = 0) => {
  const fake = fakeFetch(replies)
  const client = createClaudeClient({ apiKey: 'sk-test', fetch: fake.fetch, maxRetries })
  return { review: chunkReviewer(client, model, systemPrompt('Never flag onboarding code.')), requests: fake.requests }
}

const signal = () => new AbortController().signal

describe('prompts', () => {
  it('appends repo instructions to the system prompt only when set', () => {
    expect(systemPrompt('  ')).toBe(SYSTEM_PROMPT)
    expect(systemPrompt(' Never flag onboarding code. ')).toContain(
      '<repo_instructions>\nNever flag onboarding code.\n</repo_instructions>',
    )
  })

  it('describes the file and scope in the user prompt', () => {
    expect(userPrompt(chunk)).toContain('Review this change to `src/cart.ts` (a modified file). The whole file is shown')
    const partial = userPrompt({ ...chunk, wholeFile: false, part: 2, parts: 3 })
    expect(partial).toContain('This is part 2 of 3 of the diff.')
    expect(partial).toContain('<diff path="src/cart.ts">\n 1 1 | let sum = 0')
  })
})

describe('buildRequest', () => {
  it('asks the default model for structured findings with adaptive thinking and the refusal fallback', () => {
    const request = buildRequest('claude-opus-5-5', 'system text', chunk)
    expect(request).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      system: [{ type: 'text', text: 'system text', cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema' } },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })
    const schema = request.output_config!.format!.schema as { properties: { findings: { items: { required: string[] } } } }
    expect(schema.properties.findings.items.required).toEqual(['path', 'side', 'line', 'line_text', 'severity', 'title', 'body'])
    expect(request.messages).toEqual([{ role: 'user', content: userPrompt(chunk) }])
  })

  it('leaves out thinking, effort and fallbacks for models that do not take them', () => {
    const haiku = buildRequest('claude-haiku-4-5', 'system', chunk)
    expect(haiku.thinking).toBeUndefined()
    expect(haiku.output_config).toEqual({ format: expect.objectContaining({ type: 'json_schema' }) })
    expect(haiku.fallbacks).toBeUndefined()
    const opus48 = buildRequest('claude-opus-4-8', 'system', chunk)
    expect(opus48.thinking).toEqual({ type: 'adaptive' })
    expect(opus48.betas).toBeUndefined()
  })
})

describe('parseFindings', () => {
  it('keeps valid findings, forces the path and counts malformed ones', () => {
    const text = JSON.stringify({
      findings: [
        { ...finding, path: 'elsewhere.ts', title: '  Leftover debug log ' },
        { ...finding, side: 'left' },
        { ...finding, line: 0 },
        { ...finding, severity: 'critical' },
        { ...finding, title: '' },
      ],
    })
    expect(parseFindings(text, 'src/cart.ts')).toEqual({
      findings: [
        {
          path: 'src/cart.ts',
          side: 'new',
          line: 2,
          lineText: 'console.log(sum)',
          severity: 'suggestion',
          title: 'Leftover debug log',
          body: 'Remove the `console.log` before pushing.',
        },
      ],
      invalid: 4,
    })
  })

  it('rejects output that is not a findings object', () => {
    expect(() => parseFindings('not json', 'a.ts')).toThrow('not valid JSON')
    expect(() => parseFindings('{"items":[]}', 'a.ts')).toThrow('without a findings list')
  })
})

describe('chunkReviewer', () => {
  it('streams a request from the browser and returns findings with usage', async () => {
    const { review, requests } = reviewWith([
      () =>
        streamReply({
          text: JSON.stringify({ findings: [finding] }),
          usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50 },
        }),
    ])
    const result = await review(chunk, signal())

    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request!.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
    expect(request!.headers.get('x-api-key')).toBe('sk-test')
    expect(request!.headers.get('anthropic-dangerous-direct-browser-access')).toBe('true')
    expect(request!.headers.get('anthropic-beta')).toBe('server-side-fallback-2026-07-01')
    expect(request!.body).toMatchObject({ model: 'claude-opus-5-5', stream: true, fallbacks: 'default' })
    expect(JSON.stringify(request!.body.system)).toContain('Never flag onboarding code.')

    expect(result.findings).toEqual([expect.objectContaining({ title: 'Leftover debug log', line: 2, side: 'new' })])
    expect(result.invalid).toBe(0)
    expect(result.usage).toEqual([
      { model: 'claude-opus-5-5', inputTokens: 1200, outputTokens: 300, cacheWriteTokens: 0, cacheReadTokens: 50 },
    ])
  })

  it('reports refusals and truncated output with the tokens they used', async () => {
    const { review } = reviewWith([
      () => streamReply({ text: '', stopReason: 'refusal' }),
      () => streamReply({ text: '{"findings":[', stopReason: 'max_tokens', usage: { output_tokens: 64000 } }),
    ])
    const refusal = await review(chunk, signal()).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(ClaudeOutputError)
    expect(refusal).toMatchObject({ kind: 'refusal', usage: [expect.objectContaining({ inputTokens: 100 })] })
    await expect(review(chunk, signal())).rejects.toMatchObject({ kind: 'truncated' })
  })

  it('classifies a bad key as fatal', async () => {
    const { review } = reviewWith([() => errorReply(401, 'authentication_error', 'invalid x-api-key')])
    const failure = describeClaudeError(await review(chunk, signal()).catch((error: unknown) => error), 'claude-opus-5-5')
    expect(failure).toEqual({ kind: 'auth', message: expect.stringContaining('API key was rejected'), fatal: true })
  })

  it('classifies an unknown model as fatal', async () => {
    const { review } = reviewWith([() => errorReply(404, 'not_found_error', 'model: nope')], 'nope')
    const failure = describeClaudeError(await review(chunk, signal()).catch((error: unknown) => error), 'nope')
    expect(failure).toMatchObject({ kind: 'model', fatal: true })
    expect(failure.message).toContain('"nope"')
  })

  it('retries rate limits and overload, then succeeds', async () => {
    const { review, requests } = reviewWith(
      [
        () => errorReply(429, 'rate_limit_error', 'slow down', { 'retry-after-ms': '1' }),
        () => errorReply(529, 'overloaded_error', 'overloaded', { 'retry-after-ms': '1' }),
        () => streamReply({ text: JSON.stringify({ findings: [finding] }) }),
      ],
      'claude-opus-5-5',
      2,
    )
    const result = await review(chunk, signal())
    expect(requests).toHaveLength(3)
    expect(result.findings).toHaveLength(1)
  })

  it('names rate limits and overload once retries run out', async () => {
    const limited = reviewWith([() => errorReply(429, 'rate_limit_error', 'slow down')])
    expect(describeClaudeError(await limited.review(chunk, signal()).catch((e: unknown) => e), 'm')).toMatchObject({
      kind: 'rate-limit',
      fatal: false,
    })
    const overloaded = reviewWith([() => errorReply(529, 'overloaded_error', 'overloaded')])
    expect(describeClaudeError(await overloaded.review(chunk, signal()).catch((e: unknown) => e), 'm')).toMatchObject({
      kind: 'overloaded',
      fatal: false,
    })
  })

  it('reports a cancelled request as cancelled', async () => {
    const { review } = reviewWith([() => streamReply({})])
    const controller = new AbortController()
    controller.abort()
    const failure = describeClaudeError(await review(chunk, controller.signal).catch((e: unknown) => e), 'm')
    expect(failure.kind).toBe('cancelled')
  })
})
