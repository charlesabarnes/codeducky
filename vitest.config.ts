import { defineConfig } from 'vitest/config'
import { buildIdAt } from './shared/clientVersion.ts'

const integration = process.env.INTEGRATION === '1'

export default defineConfig({
  define: {
    __CODEDUCKY_BUILD__: JSON.stringify(buildIdAt(new Date())),
  },
  test: {
    include: integration ? ['test/**/*.integration.test.ts'] : ['test/**/*.test.ts'],
    exclude: integration ? [] : ['test/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
