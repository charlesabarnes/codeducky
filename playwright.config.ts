import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { E2E_ADMIN_PASSPHRASE, E2E_BASE, E2E_PORT } from './e2e/support/env'

// Made once by the runner; workers inherit the variable. globalTeardown removes it.
process.env.CODEDUCKY_E2E_DATA ??= mkdtempSync(join(tmpdir(), 'codeducky-e2e-'))

/** The built PWA and the API on one origin, signing in through the server's fake GitHub. */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalTeardown: './e2e/support/teardown.ts',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: E2E_BASE,
    channel: 'chromium',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && bun server/index.ts',
    url: `${E2E_BASE}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      PORT: String(E2E_PORT),
      DATA_DIR: process.env.CODEDUCKY_E2E_DATA,
      CODEDUCKY_GITHUB_FAKE: '1',
      CODEDUCKY_ADMIN_PASSPHRASE: E2E_ADMIN_PASSPHRASE,
      CODEDUCKY_PUBLIC_URL: E2E_BASE,
      CODEDUCKY_RATE_GITHUB_START: '1000',
    },
  },
})
