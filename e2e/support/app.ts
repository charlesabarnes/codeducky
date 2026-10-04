import { expect, type Page } from '@playwright/test'

/** Signs in to the fake GitHub's "Sign in as" form; the page is on it after "sign in with github". */
export async function fakeGitHub(page: Page, login: string) {
  await page.waitForURL(/\/api\/auth\/fake-github\/authorize/)
  await page.getByLabel('GitHub login').fill(login)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/** Starts a GitHub sign-in from Settings and passes the fake GitHub step, without waiting for the result. */
export async function beginSignIn(page: Page, login: string) {
  await page.goto('/settings')
  await page.getByRole('button', { name: 'sign in with github' }).click()
  await fakeGitHub(page, login)
}

/** Signs in from Settings and waits until Settings shows the account. */
export async function signIn(page: Page, login: string) {
  await beginSignIn(page, login)
  await expect(syncPanel(page).locator('.account-name', { hasText: `@${login}` })).toBeVisible()
}

export const syncPanel = (page: Page) => page.locator('#sync')

/** Answers every confirm() with OK. */
export const acceptDialogs = (page: Page) => page.on('dialog', (dialog) => void dialog.accept())

/** Waits for the header's sync status to settle on "synced". */
export const synced = (page: Page) => expect(page.getByText('synced', { exact: true }).first()).toBeVisible()
