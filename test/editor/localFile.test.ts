import { describe, expect, it } from 'vitest'
import { readLocalFile, saveLocalFile, type TextFile } from '../../src/editor/localFile'
import { memoryRoot, type MemoryOptions } from '../support/memoryHandle'

const T0 = 1_700_000_000_000
const decode = async (root: ReturnType<typeof memoryRoot>, path: string) => (await (await root.file(path)).getFile()).text()

async function open(options: MemoryOptions = {}) {
  let clock = T0 + 60_000
  const root = memoryRoot({ src: { 'app.ts': 'const a = 1\n' } }, { lastModified: T0, now: () => clock++, ...options })
  const read = await readLocalFile(root.handle, 'src/app.ts')
  if (read.kind !== 'text') throw new Error('expected text')
  return { root, opened: read.file }
}

const saveOptions = (opened: TextFile, extra = {}) => ({ format: opened.format, expected: opened.version, ...extra })

describe('readLocalFile', () => {
  it('reads text with the version it was read at', async () => {
    const { opened } = await open()
    expect(opened.text).toBe('const a = 1\n')
    expect(opened.version).toMatchObject({ lastModified: T0, size: 12 })
    expect(opened.version.oid).toMatch(/^[0-9a-f]{40}$/)
  })

  it('refuses binary, too large and missing files', async () => {
    const root = memoryRoot({ 'logo.png': new Uint8Array([137, 80, 0, 1]), 'big.txt': 'x'.repeat(50) })
    expect(await readLocalFile(root.handle, 'logo.png')).toEqual({ kind: 'binary' })
    expect(await readLocalFile(root.handle, 'big.txt', 10)).toEqual({ kind: 'too-large', size: 50 })
    expect(await readLocalFile(root.handle, 'nope/missing.ts')).toEqual({ kind: 'missing' })
  })
})

describe('saveLocalFile', () => {
  it('writes the working tree file and returns the new version', async () => {
    const { root, opened } = await open()
    const result = await saveLocalFile(root.handle, 'src/app.ts', 'const a = 2\n', saveOptions(opened))
    expect(result.kind).toBe('saved')
    expect(await decode(root, 'src/app.ts')).toBe('const a = 2\n')
    if (result.kind !== 'saved') return
    expect(result.version.lastModified).toBeGreaterThan(T0)
    expect(result.version.oid).not.toBe(opened.version.oid)

    const again = await saveLocalFile(root.handle, 'src/app.ts', 'const a = 3\n', { format: opened.format, expected: result.version })
    expect(again.kind).toBe('saved')
  })

  it('keeps the file’s CRLF line endings and byte order mark', async () => {
    const root = memoryRoot({ 'win.txt': new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a\r\nb\r\n')]) })
    const read = await readLocalFile(root.handle, 'win.txt')
    if (read.kind !== 'text') throw new Error('expected text')
    expect(read.file.text).toBe('a\nb\n')
    await saveLocalFile(root.handle, 'win.txt', 'a\nc\n', saveOptions(read.file))
    const bytes = new Uint8Array(await (await (await root.file('win.txt')).getFile()).arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder().decode(bytes.slice(3))).toBe('a\r\nc\r\n')
  })

  it('reports a conflict when the file changed on disk, and overwrites only when forced', async () => {
    const { root, opened } = await open()
    ;(await root.file('src/app.ts')).replace('const a = 99\n')
    const result = await saveLocalFile(root.handle, 'src/app.ts', 'const a = 2\n', saveOptions(opened))
    expect(result).toMatchObject({ kind: 'conflict', deleted: false, disk: { text: 'const a = 99\n' } })
    expect(await decode(root, 'src/app.ts')).toBe('const a = 99\n')

    const forced = await saveLocalFile(root.handle, 'src/app.ts', 'const a = 2\n', saveOptions(opened, { force: true }))
    expect(forced.kind).toBe('saved')
    expect(await decode(root, 'src/app.ts')).toBe('const a = 2\n')
  })

  it('does not count a new mtime with the same content as a change', async () => {
    const { root, opened } = await open()
    ;(await root.file('src/app.ts')).replace('const a = 1\n', T0 + 5_000)
    expect((await saveLocalFile(root.handle, 'src/app.ts', 'const a = 2\n', saveOptions(opened))).kind).toBe('saved')
  })

  it('reports a deleted file as a conflict and recreates it when forced', async () => {
    const { root, opened } = await open()
    await root.remove('src/app.ts')
    expect(await saveLocalFile(root.handle, 'src/app.ts', 'x\n', saveOptions(opened))).toEqual({ kind: 'conflict', deleted: true, disk: null })
    expect((await saveLocalFile(root.handle, 'src/app.ts', 'x\n', saveOptions(opened, { force: true }))).kind).toBe('saved')
    expect(await decode(root, 'src/app.ts')).toBe('x\n')
  })

  it('asks for write access only from a click, then saves', async () => {
    const { root, opened } = await open({ permissions: { readwrite: 'prompt' } })
    expect(await saveLocalFile(root.handle, 'src/app.ts', 'const a = 2\n', saveOptions(opened))).toEqual({ kind: 'needs-permission' })
    expect(root.requests).toEqual([])
    expect(await decode(root, 'src/app.ts')).toBe('const a = 1\n')

    const result = await saveLocalFile(root.handle, 'src/app.ts', 'const a = 2\n', saveOptions(opened, { allowPrompt: true }))
    expect(result.kind).toBe('saved')
    expect(root.requests).toEqual(['readwrite'])
    expect(await decode(root, 'src/app.ts')).toBe('const a = 2\n')
  })

  it('writes nothing when write access is refused', async () => {
    const { root, opened } = await open({ permissions: { readwrite: 'prompt' }, answer: 'denied' })
    const result = await saveLocalFile(root.handle, 'src/app.ts', 'const a = 2\n', saveOptions(opened, { allowPrompt: true }))
    expect(result).toEqual({ kind: 'denied' })
    expect(await decode(root, 'src/app.ts')).toBe('const a = 1\n')
  })
})
