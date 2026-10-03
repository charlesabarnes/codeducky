import { defineConfig } from 'vitest/config'

const integration = process.env.INTEGRATION === '1'

export default defineConfig({
  test: {
    include: integration ? ['test/**/*.integration.test.ts'] : ['test/**/*.test.ts'],
    exclude: integration ? [] : ['test/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
