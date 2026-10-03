import { describe, expect, it } from 'vitest'
import { HandleFs } from '../../src/fs/handleFs'
import { memoryDirectoryHandle } from '../support/memoryHandle'

const tree = {
  'README.md': '# hello\n',
  src: {
    'index.ts': 'export {}\n',
    nested: { 'deep.bin': new Uint8Array([0, 1, 2, 255]) },
  },
  '.git': { HEAD: 'ref: refs/heads/main\n' },
}

const makeFs = () => new HandleFs(memoryDirectoryHandle(tree, 1_700_000_123_456))

describe('HandleFs', () => {
  it('reads files as bytes or utf8', async () => {
    const fs = makeFs()
    expect(await fs.promises.readFile('/README.md', { encoding: 'utf8' })).toBe('# hello\n')
    expect(await fs.promises.readFile('/README.md', 'utf8')).toBe('# hello\n')
    expect(await fs.promises.readFile('/src/nested/deep.bin')).toEqual(new Uint8Array([0, 1, 2, 255]))
  })

  it('normalises duplicate slashes and dot segments', async () => {
    const fs = makeFs()
    expect(await fs.promises.readFile('//src/./nested/../index.ts', 'utf8')).toBe('export {}\n')
  })

  it('lists directories sorted', async () => {
    const fs = makeFs()
    expect(await fs.promises.readdir('/')).toEqual(['.git', 'README.md', 'src'])
    expect(await fs.promises.readdir('/src')).toEqual(['index.ts', 'nested'])
  })

  it('stats files and directories', async () => {
    const fs = makeFs()
    const file = await fs.promises.stat('/src/nested/deep.bin')
    expect(file.isFile()).toBe(true)
    expect(file.isDirectory()).toBe(false)
    expect(file.size).toBe(4)
    expect(file.mtimeMs).toBe(1_700_000_123_456)
    expect(file.mode).toBe(0o100644)

    const dir = await fs.promises.lstat('/src')
    expect(dir.isDirectory()).toBe(true)
    expect(dir.isSymbolicLink()).toBe(false)
  })

  it('reports missing paths as ENOENT, before and after a listing is cached', async () => {
    const fs = makeFs()
    await expect(fs.promises.stat('/nope')).rejects.toMatchObject({ code: 'ENOENT' })
    await fs.promises.readdir('/src')
    await expect(fs.promises.readFile('/src/missing.ts')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports ENOTDIR when traversing or listing through a file', async () => {
    const fs = makeFs()
    await expect(fs.promises.readdir('/README.md')).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(fs.promises.stat('/README.md/child')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('reports EISDIR when reading a directory', async () => {
    await expect(makeFs().promises.readFile('/src')).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('rejects every write', async () => {
    const fs = makeFs()
    for (const write of [fs.promises.writeFile, fs.promises.unlink, fs.promises.mkdir, fs.promises.rmdir, fs.promises.symlink, fs.promises.chmod]) {
      await expect(write('/x')).rejects.toMatchObject({ code: 'EROFS' })
    }
  })

  it('has no symlinks', async () => {
    await expect(makeFs().promises.readlink('/README.md')).rejects.toMatchObject({ code: 'EINVAL' })
  })

  it('exposes promises as an enumerable property for isomorphic-git', () => {
    expect(Object.getOwnPropertyDescriptor(makeFs(), 'promises')?.enumerable).toBe(true)
  })
})
