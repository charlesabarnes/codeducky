import { FsError } from './errors'
import { normalizePath, splitPath } from './path'

type Handle = FileSystemDirectoryHandle | FileSystemFileHandle

const FILE_MODE = 0o100644
const DIR_MODE = 0o40000

export interface FsStats {
  type: 'file' | 'dir'
  mode: number
  size: number
  ino: number
  dev: number
  uid: number
  gid: number
  mtimeMs: number
  ctimeMs: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface DirEntry {
  name: string
  kind: 'file' | 'directory'
}

export interface ReadFileOptions {
  encoding?: 'utf8'
}

function makeStats(type: 'file' | 'dir', size: number, mtimeMs: number): FsStats {
  return {
    type,
    mode: type === 'file' ? FILE_MODE : DIR_MODE,
    size,
    ino: 0,
    dev: 0,
    uid: 0,
    gid: 0,
    mtimeMs,
    ctimeMs: mtimeMs,
    isFile: () => type === 'file',
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => false,
  }
}

function domErrorName(error: unknown): string | undefined {
  return error instanceof Error || (typeof error === 'object' && error !== null && 'name' in error)
    ? String((error as { name: unknown }).name)
    : undefined
}

function readOnly(syscall: string) {
  return async (path: string): Promise<never> => {
    throw new FsError('EROFS', syscall, path)
  }
}

/**
 * Read-only isomorphic-git `fs` (promises flavour) over a File System Access directory handle.
 * Lookups are cached; call `clearCache()` before re-reading a tree that may have changed.
 */
export class HandleFs {
  readonly promises: {
    readFile: HandleFs['readFile']
    readdir: HandleFs['readdir']
    stat: HandleFs['stat']
    lstat: HandleFs['stat']
    readlink: HandleFs['readlink']
    writeFile: (path: string) => Promise<never>
    unlink: (path: string) => Promise<never>
    mkdir: (path: string) => Promise<never>
    rmdir: (path: string) => Promise<never>
    symlink: (path: string) => Promise<never>
    chmod: (path: string) => Promise<never>
  }

  private readonly root: FileSystemDirectoryHandle
  private handles = new Map<string, Handle | null>()
  private listings = new Map<string, string[]>()

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root
    this.handles.set('/', root)
    this.promises = {
      readFile: this.readFile.bind(this),
      readdir: this.readdir.bind(this),
      stat: this.stat.bind(this),
      lstat: this.stat.bind(this),
      readlink: this.readlink.bind(this),
      writeFile: readOnly('open'),
      unlink: readOnly('unlink'),
      mkdir: readOnly('mkdir'),
      rmdir: readOnly('rmdir'),
      symlink: readOnly('symlink'),
      chmod: readOnly('chmod'),
    }
  }

  clearCache(): void {
    this.handles = new Map([['/', this.root]])
    this.listings = new Map()
  }

  async readFile(path: string, options?: ReadFileOptions | 'utf8'): Promise<Uint8Array | string> {
    const handle = await this.resolve(path, 'open')
    if (handle.kind !== 'file') throw new FsError('EISDIR', 'read', path)
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer())
    const encoding = typeof options === 'string' ? options : options?.encoding
    return encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes
  }

  async readdir(path: string): Promise<string[]> {
    const key = normalizePath(path)
    const cached = this.listings.get(key)
    if (cached) return [...cached]
    const handle = await this.resolve(key, 'scandir')
    if (handle.kind !== 'directory') throw new FsError('ENOTDIR', 'scandir', path)
    const names: string[] = []
    for await (const [name, child] of handle.entries()) {
      names.push(name)
      this.handles.set(key === '/' ? `/${name}` : `${key}/${name}`, child)
    }
    names.sort()
    this.listings.set(key, names)
    return [...names]
  }

  async readdirTyped(path: string): Promise<DirEntry[]> {
    const key = normalizePath(path)
    const names = await this.readdir(key)
    return names.map((name) => {
      const handle = this.handles.get(key === '/' ? `/${name}` : `${key}/${name}`)
      return { name, kind: handle?.kind === 'directory' ? 'directory' : 'file' }
    })
  }

  async stat(path: string): Promise<FsStats> {
    const handle = await this.resolve(path, 'stat')
    if (handle.kind === 'directory') return makeStats('dir', 0, 0)
    const file = await handle.getFile()
    return makeStats('file', file.size, file.lastModified)
  }

  async readlink(path: string): Promise<never> {
    await this.resolve(path, 'readlink')
    throw new FsError('EINVAL', 'readlink', path)
  }

  private async resolve(path: string, syscall: string): Promise<Handle> {
    const segments = splitPath(path)
    let current: Handle = this.root
    let currentKey = ''
    for (const segment of segments) {
      if (current.kind !== 'directory') throw new FsError('ENOTDIR', syscall, path)
      const key = `${currentKey}/${segment}`
      const next = await this.child(current, currentKey || '/', key, segment)
      if (!next) throw new FsError('ENOENT', syscall, path)
      current = next
      currentKey = key
    }
    return current
  }

  private async child(
    parent: FileSystemDirectoryHandle,
    parentKey: string,
    key: string,
    name: string,
  ): Promise<Handle | null> {
    const cached = this.handles.get(key)
    if (cached !== undefined) return cached
    if (this.listings.has(parentKey)) return null
    const found = await lookup(parent, name)
    this.handles.set(key, found)
    return found
  }
}

async function lookup(parent: FileSystemDirectoryHandle, name: string): Promise<Handle | null> {
  try {
    return await parent.getFileHandle(name)
  } catch (error) {
    const reason = domErrorName(error)
    if (reason === 'TypeMismatchError') return parent.getDirectoryHandle(name)
    if (reason === 'NotFoundError' || reason === 'TypeError') return null
    throw error
  }
}
