import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

type NodeHandle = NodeFileHandle | NodeDirectoryHandle

function notFound(name: string): DOMException {
  return new DOMException(`${name} not found`, 'NotFoundError')
}

class NodeFileHandle {
  readonly kind = 'file'
  readonly name: string
  private readonly path: string

  constructor(path: string) {
    this.path = path
    this.name = basename(path)
  }

  async getFile() {
    const info = await stat(this.path)
    const path = this.path
    return {
      name: this.name,
      size: info.size,
      lastModified: info.mtimeMs,
      async arrayBuffer() {
        const buffer = await readFile(path)
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      },
    }
  }
}

class NodeDirectoryHandle {
  readonly kind = 'directory'
  readonly name: string
  private readonly path: string

  constructor(path: string) {
    this.path = path
    this.name = basename(path)
  }

  async *entries(): AsyncIterableIterator<[string, NodeHandle]> {
    for (const entry of await readdir(this.path, { withFileTypes: true })) {
      const child = await this.childOf(entry.name)
      if (child) yield [entry.name, child]
    }
  }

  async getFileHandle(name: string): Promise<NodeFileHandle> {
    const child = await this.childOf(name)
    if (!child) throw notFound(name)
    if (child.kind !== 'file') throw new DOMException(`${name} is a directory`, 'TypeMismatchError')
    return child
  }

  async getDirectoryHandle(name: string): Promise<NodeDirectoryHandle> {
    const child = await this.childOf(name)
    if (!child) throw notFound(name)
    if (child.kind !== 'directory') throw new DOMException(`${name} is a file`, 'TypeMismatchError')
    return child
  }

  private async childOf(name: string): Promise<NodeHandle | null> {
    const path = join(this.path, name)
    const info = await stat(path).catch(() => null)
    if (!info) return null
    if (info.isDirectory()) return new NodeDirectoryHandle(path)
    if (info.isFile()) return new NodeFileHandle(path)
    return null
  }
}

export function nodeDirectoryHandle(path: string): FileSystemDirectoryHandle {
  return new NodeDirectoryHandle(path) as unknown as FileSystemDirectoryHandle
}
