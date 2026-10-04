import { rmSync } from 'node:fs'

export default function teardown() {
  const dir = process.env.CODEDUCKY_E2E_DATA
  if (dir) rmSync(dir, { recursive: true, force: true })
}
