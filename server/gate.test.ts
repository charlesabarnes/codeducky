import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SyncResponse, WireChange } from '../shared/sync'
import { checklist, note, repo, REPO, session, ticked } from './fixtures'
import { renderScript } from './gate/scripts'
import { createUserSession, login, makeApp, OWNER, request, TEST_ORIGIN, userIdFor } from './testing'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

async function setup(changes: WireChange[]) {
  const made = makeApp()
  cleanups.push(made.cleanup)
  const device = await login(made.app)
  const pushed = (await (await request(made.app, 'POST', '/api/sync', { cursor: 0, changes }, device)).json()) as SyncResponse
  expect(pushed.rejected).toEqual([])
  const { token } = made.tokens.issue({ userId: userIdFor(made.db, OWNER), name: 'Pre-push gate', kind: 'api' })
  const gate = async (repoName: string, branch: string, extra = '') => {
    const res = await made.app.request(
      `${TEST_ORIGIN}/api/gate?repo=${encodeURIComponent(repoName)}&branch=${encodeURIComponent(branch)}${extra}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    return res
  }
  return { ...made, device, token, gate }
}

interface GateBody {
  pass: boolean
  reasons: string[]
  counts: { blockers: number; issues: number; uncheckedRequired: number }
  url: string
  session: string | null
}

const BASE = [
  repo(),
  session('s1', 'feature/tax'),
  session('s-old', 'feature/tax', { startedAt: 1, status: 'archived' }),
  session('s2', 'clean'),
]

describe('pre-push gate', () => {
  it('blocks on open blocker and issue notes only', async () => {
    const { gate } = await setup([
      ...BASE,
      note('n-blocker', 's1', { severity: 'blocker', title: 'Drops the last line item', path: 'src/b.ts' }),
      note('n-issue', 's1'),
      note('n-nit', 's1', { severity: 'nit' }),
      note('n-suggestion', 's1', { severity: 'suggestion' }),
      note('n-resolved', 's1', { severity: 'blocker', status: 'resolved' }),
      note('n-suggested', 's1', { severity: 'blocker', status: 'suggested', source: 'mcp' }),
      note('n-dismissed', 's1', { severity: 'issue', status: 'dismissed', source: 'mcp' }),
      note('n-archived', 's-old', { severity: 'blocker' }),
    ])
    const res = await gate(REPO, 'feature/tax')
    expect(res.status).toBe(200)
    const body = (await res.json()) as GateBody
    expect(body).toEqual({
      pass: false,
      reasons: ['blocker: src/b.ts:12 Drops the last line item', 'issue: src/invoice.ts:12 Body of n-issue'],
      counts: { blockers: 1, issues: 1, uncheckedRequired: 0 },
      url: `${TEST_ORIGIN}/sessions/s1`,
      session: 's1',
    })
  })

  it('blocks on unticked items of required checklists that apply to the repo', async () => {
    const { gate } = await setup([
      ...BASE,
      checklist('cl-req', 'Before push', [['i1', 'Tests pass'], ['i2', 'Migrations reviewed']], { required: true }),
      checklist('cl-opt', 'Nice to have', [['i3', 'Docs updated']]),
      checklist('cl-other', 'Other repo', [['i9', 'Nope']], { scope: 'gh:x/y', required: true }),
      ticked('s1', 'i1'),
      ticked('s1', 'i2', false),
    ])
    const body = (await (await gate(REPO, 'feature/tax')).json()) as GateBody
    expect(body.pass).toBe(false)
    expect(body.reasons).toEqual(['Unticked on required checklist "Before push": Migrations reviewed'])
    expect(body.counts).toEqual({ blockers: 0, issues: 0, uncheckedRequired: 1 })
  })

  it('passes a clean branch, and passes with a reason when there is no session or repo', async () => {
    const { gate } = await setup([...BASE, note('n-nit', 's2', { severity: 'nit' })])
    expect(await (await gate('CharlesABarnes/Invoice-Service', 'clean')).json()).toMatchObject({ pass: true, reasons: [], session: 's2' })
    const noSession = (await (await gate(REPO, 'nope')).json()) as GateBody
    expect(noSession).toMatchObject({ pass: true, session: null, url: TEST_ORIGIN })
    expect(noSession.reasons[0]).toContain('No Code Ducky session for')
    expect(((await (await gate('x/y', 'main')).json()) as GateBody).reasons[0]).toContain('x/y is not in Code Ducky')
  })

  it('answers in plain text for the hook scripts', async () => {
    const { gate } = await setup([...BASE, note('n-issue', 's1', { title: 'Line\nbreak' })])
    const res = await gate(REPO, 'feature/tax', '&format=text')
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe(`FAIL\n- issue: src/invoice.ts:12 Line break\nurl ${TEST_ORIGIN}/sessions/s1\n`)
    expect(await (await gate(REPO, 'clean', '&format=text')).text()).toBe(`PASS\nurl ${TEST_ORIGIN}/sessions/s2\n`)
  })

  it('caps the reasons it lists', async () => {
    const many = Array.from({ length: 13 }, (_, i) => note(`n${i}`, 's1', { anchor: { line: i + 1, side: 'new', text: 'x', before: [], after: [] } }))
    const body = (await (await setup([...BASE, ...many])).gate(REPO, 'feature/tax').then((r) => r.json())) as GateBody
    expect(body.counts.issues).toBe(13)
    expect(body.reasons).toHaveLength(11)
    expect(body.reasons.at(-1)).toBe('…and 3 more')
  })

  it('needs an api or oauth token, and repo and branch', async () => {
    const { app, device, token } = await setup(BASE)
    expect((await app.request(`${TEST_ORIGIN}/api/gate?repo=${REPO}&branch=x`)).status).toBe(401)
    const asDevice = await app.request(`${TEST_ORIGIN}/api/gate?repo=${REPO}&branch=x`, { headers: { Authorization: `Bearer ${device}` } })
    expect(asDevice.status).toBe(403)
    const missing = await app.request(`${TEST_ORIGIN}/api/gate?repo=${REPO}`, { headers: { Authorization: `Bearer ${token}` } })
    expect(missing.status).toBe(400)
  })

  it('checks only the caller\'s own reviews', async () => {
    const { app, db, tokens, gate } = await setup([...BASE, note('n-blocker', 's1', { severity: 'blocker' })])
    const bob = createUserSession(db, 'bob')
    const { token } = tokens.issue({ userId: bob.user.id, name: 'Bob gate', kind: 'api' })
    const bobGate = async () =>
      (await (await app.request(`${TEST_ORIGIN}/api/gate?repo=${REPO}&branch=feature/tax`, { headers: { Authorization: `Bearer ${token}` } })).json()) as GateBody

    expect(await bobGate()).toMatchObject({ pass: true, reasons: [`${REPO} is not in Code Ducky; nothing to check.`], session: null })
    await request(app, 'POST', '/api/sync', { cursor: 0, changes: [repo()] }, bob.token)
    expect((await bobGate()).reasons).toEqual([`No Code Ducky session for ${REPO}@feature/tax; nothing to check.`])
    expect(((await (await gate(REPO, 'feature/tax')).json()) as GateBody).pass).toBe(false)
  })
})

describe('hook scripts', () => {
  it('serves both scripts with the shared helpers and this server baked in', async () => {
    const { app } = await setup([])
    for (const name of ['pre-push.sh', 'claude-code-hook.sh']) {
      const res = await app.request(`${TEST_ORIGIN}/gate/${name}`, { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'duck.example' } })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/x-shellscript')
      const text = await res.text()
      expect(text.startsWith('#!/bin/sh\n')).toBe(true)
      expect(text).toContain("CODEDUCKY_DEFAULT_URL='https://duck.example'")
      expect(text).toContain('curl -sS --max-time 2')
      expect(text).not.toContain('# @common')
    }
    expect((await app.request(`${TEST_ORIGIN}/gate/other.sh`)).status).toBe(404)
  })

  it('renders scripts that parse as POSIX sh', async () => {
    for (const name of ['pre-push.sh', 'claude-code-hook.sh'] as const) {
      const proc = Bun.spawnSync(['sh', '-n'], { stdin: new TextEncoder().encode(renderScript(name, 'http://localhost:8787')) })
      expect(proc.exitCode).toBe(0)
    }
  })
})

describe('hook scripts against a running server', () => {
  async function serve(changes: WireChange[]) {
    const made = await setup(changes)
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: made.app.fetch })
    const dir = mkdtempSync(join(tmpdir(), 'codeducky-hook-'))
    cleanups.push(() => {
      void server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    })
    const origin = `http://127.0.0.1:${server.port}`
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
    git('init', '-q', '-b', 'feature/tax')
    git('remote', 'add', 'origin', 'git@github.com:charlesabarnes/invoice-service.git')
    // Only the tools the scripts need: without `security`, a real Keychain item cannot shadow the test token.
    const bin = join(dir, '.bin')
    mkdirSync(bin)
    for (const tool of ['sh', 'git', 'curl', 'sed', 'tr', 'awk', 'head', 'tail', 'cat']) symlinkSync(Bun.which(tool)!, join(bin, tool))
    // Async: a blocking spawn would stall the in-process server the script calls.
    const run = async (name: 'pre-push.sh' | 'claude-code-hook.sh', stdin: string, args: string[] = [], env: Record<string, string> = {}) => {
      const script = join(dir, name)
      writeFileSync(script, renderScript(name, origin), { mode: 0o755 })
      const proc = Bun.spawn(['sh', script, ...args], {
        cwd: dir,
        stdin: new TextEncoder().encode(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PATH: bin, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', CODEDUCKY_TOKEN: made.token, ...env },
      })
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      return { code, out, err }
    }
    return { run, dir }
  }
  const hookInput = (cwd: string, command: string) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } })
  const prePushArgs = ['origin', 'git@github.com:charlesabarnes/invoice-service.git']
  const refs = (branch: string) => `refs/heads/${branch} ${'a'.repeat(40)} refs/heads/${branch} ${'0'.repeat(40)}\n`

  it('pre-push blocks a failing branch and lets a clean one through', async () => {
    const { run } = await serve([...BASE, note('n1', 's1', { severity: 'blocker', title: 'Broken' })])
    const failed = await run('pre-push.sh', refs('feature/tax'), prePushArgs)
    expect(failed.code).toBe(1)
    expect(failed.err).toContain('blocker: src/invoice.ts:12 Broken')
    expect(failed.err).toContain('/sessions/s1')
    expect((await run('pre-push.sh', refs('clean'), prePushArgs)).code).toBe(0)
    const noToken = await run('pre-push.sh', refs('feature/tax'), prePushArgs, { CODEDUCKY_TOKEN: '' })
    expect(noToken.code).toBe(0)
    expect(noToken.err).toContain('no token')
  })

  it('the Claude Code hook denies a failing git push with the reasons', async () => {
    const { run, dir } = await serve([...BASE, note('n1', 's1', { severity: 'issue', title: 'Say "why"' })])
    const denied = await run('claude-code-hook.sh', hookInput(dir, 'git push origin feature/tax'))
    expect(denied.code).toBe(0)
    const output = JSON.parse(denied.out) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } }
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('issue: src/invoice.ts:12 Say "why"')
    for (const command of ['git status', 'git push --no-verify', 'git push origin clean']) {
      expect((await run('claude-code-hook.sh', hookInput(dir, command))).out).toBe('')
    }
  })
})
