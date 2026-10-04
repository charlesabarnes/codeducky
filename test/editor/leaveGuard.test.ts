import { describe, expect, it } from 'vitest'
import { discardPrompt, guardUnload, leavesFile } from '../../src/editor/leaveGuard'

const at = (pathname: string, search = '') => ({ pathname, search })

describe('leavesFile', () => {
  const current = at('/sessions/s1', '?file=src%2Fa.ts&view=edit')

  it('lets the diff and editor switch for the same file through', () => {
    expect(leavesFile('src/a.ts', current, at('/sessions/s1', '?file=src%2Fa.ts'))).toBe(false)
    expect(leavesFile('src/a.ts', current, at('/sessions/s1', '?file=src/a.ts&view=edit'))).toBe(false)
  })

  it('stops a switch to another file', () => {
    expect(leavesFile('src/a.ts', current, at('/sessions/s1', '?file=src%2Fb.ts&view=edit'))).toBe(true)
  })

  it('stops leaving the session, even when no file is named', () => {
    expect(leavesFile('src/a.ts', current, at('/inbox'))).toBe(true)
    expect(leavesFile('src/a.ts', current, at('/sessions/s1'))).toBe(true)
  })
})

describe('guardUnload', () => {
  const event = () => ({ prevented: false, returnValue: undefined as unknown, preventDefault() { this.prevented = true } })

  it('asks the browser to confirm closing with unsaved changes', () => {
    const unload = event()
    expect(guardUnload(unload, true)).toBe(true)
    expect(unload.prevented).toBe(true)
    expect(unload.returnValue).toBe('')
  })

  it('leaves a clean editor alone', () => {
    const unload = event()
    expect(guardUnload(unload, false)).toBe(false)
    expect(unload.prevented).toBe(false)
  })

  it('names the file in the prompt', () => {
    expect(discardPrompt('src/a.ts')).toContain('src/a.ts')
  })
})
