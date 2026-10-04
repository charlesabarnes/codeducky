import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createHash } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { acceptDialogs, beginSignIn, fakeGitHub, signIn, synced, syncPanel } from './support/app'
import { openBrowser } from './support/browser'
import { E2E_ADMIN_PASSPHRASE, E2E_BASE } from './support/env'
import { makeRepo } from './support/repo'

test.describe.configure({ mode: 'serial' })

const ledger = makeRepo('alice', 'ledger')
const NOTE = 'Sum with a running total instead of counting'
let sessionPath = ''

/** The repos page's count, once the page has loaded and, when signed in, synced. */
async function repoCount(page: Page, signedIn = true) {
  await page.goto('/')
  if (signedIn) await synced(page)
  return page.getByText(/^\d+ repos?$/)
}

test('alice adds a note and it syncs to her second browser', async () => {
  const laptop = await openBrowser(ledger)
  const desktop = await openBrowser(ledger)
  try {
    const { page } = laptop
    await signIn(page, 'alice')
    await page.goto('/')
    await page.getByRole('button', { name: 'open repo folder' }).click()
    await page.getByRole('button', { name: 'start session' }).click()
    await page.waitForURL(/\/sessions\//)
    sessionPath = new URL(page.url()).pathname
    const added = page.locator('.diff-table tr', { hasText: 'items.reduce' })
    await added.hover()
    await added.getByRole('button', { name: 'Comment on this line' }).click()
    await page.getByPlaceholder('Leave a note (markdown)').fill(NOTE)
    await page.getByPlaceholder('Leave a note (markdown)').press('Control+Enter')
    await expect(page.getByText(NOTE).first()).toBeVisible()
    await page.goto('/settings')
    await syncPanel(page).getByRole('button', { name: 'sync now' }).click()
    await synced(page)

    await signIn(desktop.page, 'alice')
    await synced(desktop.page)
    await desktop.page.goto(sessionPath)
    await desktop.page.getByRole('button', { name: 'open repo folder' }).click()
    await expect(desktop.page.getByText(NOTE).first()).toBeVisible()
  } finally {
    await laptop.close()
    await desktop.close()
  }
})

test('bob, in his own browser, sees none of it', async () => {
  const { page, close } = await openBrowser(ledger)
  try {
    await signIn(page, 'bob')
    await expect(await repoCount(page)).toHaveText('0 repos')
    await page.goto(sessionPath)
    await expect(page.getByText('Session not found.')).toBeVisible()
  } finally {
    await close()
  }
})

test('signing in to another account asks first: cancel keeps the data, confirm removes it', async () => {
  const { page, close } = await openBrowser()
  acceptDialogs(page)
  try {
    await signIn(page, 'alice')
    await expect(await repoCount(page)).toHaveText('1 repo')
    await page.goto('/settings')
    await syncPanel(page).getByRole('button', { name: 'sign out', exact: true }).click()

    await beginSignIn(page, 'bob')
    const dialog = page.getByRole('dialog', { name: 'switch account' })
    await expect(dialog).toContainText('This browser holds review data from @alice')
    await dialog.getByRole('button', { name: 'cancel', exact: true }).click()
    await expect(syncPanel(page).getByRole('button', { name: 'sign in with github' })).toBeVisible()
    await expect(await repoCount(page, false)).toHaveText('1 repo')

    await beginSignIn(page, 'bob')
    await page.getByRole('dialog', { name: 'switch account' }).getByRole('button', { name: 'remove and continue' }).click()
    await expect(syncPanel(page).locator('.account-name', { hasText: '@bob' })).toBeVisible()
    await expect(await repoCount(page)).toHaveText('0 repos')
  } finally {
    await close()
  }
})

test('"sign out and remove data" leaves nothing of the account in the browser', async () => {
  const { page, close } = await openBrowser()
  acceptDialogs(page)
  try {
    await signIn(page, 'alice')
    await expect(await repoCount(page)).toHaveText('1 repo')
    await page.goto('/settings')
    await syncPanel(page).getByRole('button', { name: 'sign out and remove data from this browser' }).click()
    await expect(syncPanel(page).getByRole('button', { name: 'sign in with github' })).toBeVisible()
    await expect(await repoCount(page, false)).toHaveText('0 repos')
    const left = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('codeducky')
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error)
      })
      const counts: Record<string, number> = {}
      for (const name of ['repos', 'sessions', 'notes', 'outbox', 'syncMeta']) {
        if (!db.objectStoreNames.contains(name)) continue
        counts[name] = await new Promise<number>((resolve) => {
          const request = db.transaction(name).objectStore(name).count()
          request.onsuccess = () => resolve(request.result)
        })
      }
      db.close()
      return counts
    })
    expect(left).toEqual({ repos: 0, sessions: 0, notes: 0, outbox: 0, syncMeta: 0 })

    // No account is bound any more, so another account signs in without the switch dialog.
    await signIn(page, 'bob')
  } finally {
    await close()
  }
})

test('an MCP client approved through GitHub sees only alice\'s data', async ({ page, request }) => {
  const redirectUri = 'http://127.0.0.1:53682/callback'
  const registered = await request.post('/oauth/register', {
    data: { client_name: 'E2E Claude', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] },
  })
  const { client_id: clientId } = (await registered.json()) as { client_id: string }
  const verifier = 'e2e-verifier-'.padEnd(60, 'x')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const authorize = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'e2e-state',
  })
  let landed: URL | null = null
  await page.route(`${redirectUri}**`, (route) => {
    landed = new URL(route.request().url())
    return route.fulfill({ body: 'done' })
  })

  await page.goto(`/oauth/authorize?${authorize}`)
  await fakeGitHub(page, 'alice')
  await expect(page.getByText('Signed in to GitHub as @alice')).toBeVisible()
  await expect(page.getByText('E2E Claude')).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect.poll(() => landed?.searchParams.get('state')).toBe('e2e-state')
  const code = landed!.searchParams.get('code')!
  expect(code).toBeTruthy()

  const token = await request.post('/oauth/token', {
    form: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri },
  })
  expect(token.status()).toBe(200)
  const { access_token: accessToken } = (await token.json()) as { access_token: string }

  const client = new Client({ name: 'codeducky-e2e', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${E2E_BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }),
  )
  try {
    const result = (await client.callTool({ name: 'list_repos', arguments: {} })) as CallToolResult
    const { repos } = JSON.parse((result.content[0] as { text: string }).text) as { repos: { repo: string; branches: { openNotes: number }[] }[] }
    expect(repos).toMatchObject([{ repo: 'alice/ledger', branches: [{ openNotes: 1 }] }])
  } finally {
    await client.close()
  }
})

test('an admin disables bob, and bob\'s open tab shows the sign-in expired', async () => {
  const bob = await openBrowser()
  const admin = await openBrowser()
  try {
    await signIn(bob.page, 'bob')

    await admin.page.goto('/settings')
    await admin.page.getByText('admin sign-in').click()
    await admin.page.getByLabel('admin passphrase').fill(E2E_ADMIN_PASSPHRASE)
    await admin.page.getByRole('button', { name: 'sign in as admin' }).click()
    const row = admin.page.locator('#admin tr', { hasText: '@bob' })
    await row.getByRole('button', { name: 'disable' }).click()
    await admin.page.getByRole('button', { name: 'yes, disable' }).click()
    await expect(row.getByText('disabled', { exact: true })).toBeVisible()

    await bob.page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(syncPanel(bob.page).getByText("This device's sign-in was revoked or expired.", { exact: false })).toBeVisible()
  } finally {
    await bob.close()
    await admin.close()
  }
})
