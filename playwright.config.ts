import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { E2E_ADMIN_PASSPHRASE, E2E_BASE, E2E_PORT } from './e2e/support/env'

// Made once by the runner; workers inherit the variable. globalTeardown removes it only if this run made it.
delete process.env.CODEDUCKY_E2E_DATA_CREATED
if (!process.env.CODEDUCKY_E2E_DATA) {
  process.env.CODEDUCKY_E2E_DATA = mkdtempSync(join(tmpdir(), 'codeducky-e2e-'))
  process.env.CODEDUCKY_E2E_DATA_CREATED = '1'
}

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
    // The server never runs in production mode here, whatever NODE_ENV the shell has.
    command: 'npm run build && NODE_ENV=test bun server/index.ts',
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
