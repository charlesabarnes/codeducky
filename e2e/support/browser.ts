import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from '@playwright/test'
import { E2E_BASE } from './env'
import { stubFolderPicker, writeRepo, type RepoFixture } from './repo'

export interface E2EBrowser {
  context: BrowserContext
  page: Page
  close: () => Promise<void>
}

/**
 * A separate browser profile, as on a second device. Profiles live on disk rather than in an
 * incognito context, because Chromium crashes reading a stored origin-private folder handle back
 * from IndexedDB off the record.
 */
export async function openBrowser(repo?: RepoFixture): Promise<E2EBrowser> {
  const profile = mkdtempSync(join(tmpdir(), 'codeducky-e2e-profile-'))
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', baseURL: E2E_BASE, serviceWorkers: 'block' })
  context.setDefaultTimeout(15_000)
  if (repo) await stubFolderPicker(context, repo)
  const page = context.pages()[0] ?? (await context.newPage())
  if (repo) {
    await page.goto('/')
    await writeRepo(page, repo)
  }
  return {
    context,
    page,
    close: async () => {
      await context.close()
      rmSync(profile, { recursive: true, force: true })
    },
  }
}
