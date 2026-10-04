import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'

export interface RepoFixture {
  /** The folder name, as the picker returns it. */
  name: string
  /** Every file of the checkout, .git included, base64 by relative path. */
  files: Record<string, string>
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E',
  GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E',
  GIT_COMMITTER_EMAIL: 'e2e@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: tmpdir(),
}

function listFiles(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'hooks' ? [] : listFiles(path, root)
    return [relative(root, path)]
  })
}

/** A checkout of github.com/<owner>/<name> on a feature branch, one commit ahead of origin/main. */
export function makeRepo(owner: string, name: string): RepoFixture {
  const dir = mkdtempSync(join(tmpdir(), 'codeducky-e2e-repo-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: GIT_ENV, stdio: 'ignore' })
  try {
    git('init', '-q', '-b', 'main')
    git('remote', 'add', 'origin', `https://github.com/${owner}/${name}.git`)
    writeFileSync(join(dir, 'ledger.ts'), 'export const total = (items: number[]) => items.length\n')
    git('add', '.')
    git('commit', '-q', '-m', 'Start')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    git('checkout', '-q', '-b', 'feature/sum')
    writeFileSync(join(dir, 'ledger.ts'), 'export const total = (items: number[]) => items.reduce((a, b) => a + b, 0)\n')
    git('commit', '-q', '-am', 'Sum the items')
    const files = Object.fromEntries(listFiles(dir).map((path) => [path, readFileSync(join(dir, path)).toString('base64')]))
    return { name, files }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Playwright cannot drive the folder picker, so "open repo folder" gets the checkout from the origin-private file system. */
export async function stubFolderPicker(context: BrowserContext, repo: RepoFixture) {
  await context.addInitScript((name) => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(name)
  }, repo.name)
}

/** Writes the checkout into the page's origin-private file system. */
export async function writeRepo(page: Page, repo: RepoFixture) {
  await page.evaluate(async ({ name, files }) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true })
    for (const [path, base64] of Object.entries(files)) {
      const parts = path.split('/')
      let dir = root
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true })
      const writable = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable()
      await writable.write(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))
      await writable.close()
    }
  }, repo)
}
