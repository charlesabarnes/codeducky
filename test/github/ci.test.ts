import { describe, expect, it } from 'vitest'
import { fetchCi, groupAnnotations, placeAnnotations, pollDelayMs, summarize } from '../../src/github/ci'
import { createGitHubClient } from '../../src/github/client'
import type { CheckAnnotation, CheckRun } from '../../src/github/types'
import { mockFetch } from './mockFetch'

const ref = { owner: 'charlesabarnes', name: 'rubberduck' }
const SHA = 'a'.repeat(40)

const rawRun = (id: number, status: string, conclusion: string | null, annotations = 0) => ({
  id,
  name: `job-${id}`,
  status,
  conclusion,
  html_url: `https://github.com/charlesabarnes/rubberduck/runs/${id}`,
  details_url: null,
  output: { title: null, annotations_count: annotations },
  app: { name: 'GitHub Actions' },
})

const rawAnnotation = (path: string, line: number, level = 'failure', end = line) => ({
  path,
  start_line: line,
  end_line: end,
  annotation_level: level,
  title: 'tsc',
  message: `problem at ${line}`,
  raw_details: '',
})

const run = (overrides: Partial<CheckRun>): CheckRun => ({
  id: 1,
  name: 'job',
  status: 'completed',
  conclusion: 'success',
  htmlUrl: null,
  detailsUrl: null,
  title: null,
  annotationsCount: 0,
  app: null,
  ...overrides,
})

describe('fetchCi', () => {
  it('reads paginated check runs and the annotations of runs that have any', async () => {
    const page2 = `https://api.github.com/repos/charlesabarnes/rubberduck/commits/${SHA}/check-runs?per_page=100&page=2`
    const { fetch, calls } = mockFetch([
      { match: /check-runs\?per_page=100&page=2$/, body: { total_count: 3, check_runs: [rawRun(3, 'in_progress', null)] } },
      {
        match: /commits\/a+\/check-runs\?per_page=100$/,
        body: { total_count: 3, check_runs: [rawRun(1, 'completed', 'failure', 3), rawRun(2, 'completed', 'success')] },
        headers: { link: `<${page2}>; rel="next"` },
      },
      {
        match: /check-runs\/1\/annotations\?per_page=100&page=2$/,
        body: [rawAnnotation('src/a.ts', 9, 'warning')],
      },
      {
        match: /check-runs\/1\/annotations\?per_page=100$/,
        body: [rawAnnotation('src/a.ts', 12), rawAnnotation('.github', 0)],
        headers: { link: '<https://api.github.com/repos/charlesabarnes/rubberduck/check-runs/1/annotations?per_page=100&page=2>; rel="next"' },
      },
    ])
    const gh = createGitHubClient({ token: 't', fetch })
    const snapshot = (await fetchCi(gh, ref, SHA))!
    expect(snapshot.runs.map((r) => [r.id, r.status, r.conclusion])).toEqual([
      [1, 'completed', 'failure'],
      [2, 'completed', 'success'],
      [3, 'in_progress', null],
    ])
    expect(snapshot.annotations.map((a) => `${a.path}:${a.startLine}:${a.level}`)).toEqual(['.github:0:failure', 'src/a.ts:9:warning', 'src/a.ts:12:failure'])
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
    expect(calls.some((call) => call.url.pathname.includes('/check-runs/2/'))).toBe(false)
  })

  it('returns null when GitHub does not have the commit', async () => {
    const { fetch } = mockFetch([{ match: /check-runs/, status: 422, body: { message: 'No commit found for SHA' } }])
    expect(await fetchCi(createGitHubClient({ token: 't', fetch }), ref, SHA)).toBeNull()
  })
})

describe('summarize', () => {
  it('fails if any run failed, else pends, else passes', () => {
    expect(summarize([]).state).toBe('none')
    expect(summarize([run({}), run({ conclusion: 'skipped' })])).toMatchObject({ state: 'pass', passed: 1, skipped: 1 })
    expect(summarize([run({}), run({ status: 'queued', conclusion: null })])).toMatchObject({ state: 'pending', pending: 1 })
    expect(summarize([run({ status: 'in_progress', conclusion: null }), run({ conclusion: 'timed_out' })])).toMatchObject({ state: 'fail', failed: 1 })
  })
})

describe('pollDelayMs', () => {
  it('backs off to a minute', () => {
    expect([0, 1, 2, 3, 9].map(pollDelayMs)).toEqual([10_000, 20_000, 40_000, 60_000, 60_000])
  })
})

describe('annotation mapping', () => {
  const annotation = (path: string, startLine: number, endLine = startLine): CheckAnnotation => ({
    checkRunId: 1,
    path,
    startLine,
    endLine,
    level: 'failure',
    title: null,
    message: 'x',
    rawDetails: null,
  })

  it('groups by changed path and keeps the rest aside', () => {
    const grouped = groupAnnotations([annotation('a.ts', 1), annotation('b.ts', 2), annotation('a.ts', 3)], new Set(['a.ts']))
    expect(grouped.byPath.get('a.ts')?.map((a) => a.startLine)).toEqual([1, 3])
    expect(grouped.elsewhere.map((a) => a.path)).toEqual(['b.ts'])
  })

  it('places annotations on their last line of the new side', () => {
    const placed = placeAnnotations([annotation('a.ts', 4), annotation('a.ts', 5, 7), annotation('a.ts', 99), annotation('a.ts', 0)], {
      newLineCount: 10,
      matchesCheckedCommit: true,
    })
    expect([...placed.byLine.keys()]).toEqual([4, 7])
    expect(placed.unplaced.map((entry) => entry.reason)).toEqual(['Line 99 is past the end of the file', 'Not on a line'])
  })

  it('does not place annotations on a file that changed since the checked commit', () => {
    const placed = placeAnnotations([annotation('a.ts', 4)], { newLineCount: 10, matchesCheckedCommit: false })
    expect(placed.byLine.size).toBe(0)
    expect(placed.unplaced[0]!.reason).toMatch(/changed since/)
  })

  it('cannot place annotations on a deleted file', () => {
    const placed = placeAnnotations([annotation('a.ts', 4)], { newLineCount: null, matchesCheckedCommit: true })
    expect(placed.unplaced).toHaveLength(1)
  })
})
