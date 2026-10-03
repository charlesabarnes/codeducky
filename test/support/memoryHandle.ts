export interface MemoryTree {
  [name: string]: string | Uint8Array | MemoryTree
}

const encoder = new TextEncoder()

class MemoryFileHandle {
  readonly kind = 'file'
  readonly name: string
  private readonly bytes: Uint8Array
  private readonly lastModified: number

  constructor(name: string, bytes: Uint8Array, lastModified: number) {
    this.name = name
    this.bytes = bytes
    this.lastModified = lastModified
  }

  async getFile(): Promise<File> {
    return new File([this.bytes as Uint8Array<ArrayBuffer>], this.name, { lastModified: this.lastModified })
  }
}

class MemoryDirectoryHandle {
  readonly kind = 'directory'
  readonly name: string
  private readonly children = new Map<string, MemoryFileHandle | MemoryDirectoryHandle>()

  constructor(name: string, tree: MemoryTree, lastModified: number) {
    this.name = name
    for (const [childName, value] of Object.entries(tree)) {
      this.children.set(
        childName,
        typeof value === 'string' || value instanceof Uint8Array
          ? new MemoryFileHandle(childName, typeof value === 'string' ? encoder.encode(value) : value, lastModified)
          : new MemoryDirectoryHandle(childName, value, lastModified),
      )
    }
  }

  async *entries(): AsyncIterableIterator<[string, MemoryFileHandle | MemoryDirectoryHandle]> {
    yield* this.children.entries()
  }

  async getFileHandle(name: string): Promise<MemoryFileHandle> {
    const child = this.children.get(name)
    if (!child) throw new DOMException(`${name} not found`, 'NotFoundError')
    if (child.kind !== 'file') throw new DOMException(`${name} is a directory`, 'TypeMismatchError')
    return child
  }

  async getDirectoryHandle(name: string): Promise<MemoryDirectoryHandle> {
    const child = this.children.get(name)
    if (!child) throw new DOMException(`${name} not found`, 'NotFoundError')
    if (child.kind !== 'directory') throw new DOMException(`${name} is a file`, 'TypeMismatchError')
    return child
  }
}

export function memoryDirectoryHandle(tree: MemoryTree, lastModified = 1_700_000_000_000): FileSystemDirectoryHandle {
  return new MemoryDirectoryHandle('root', tree, lastModified) as unknown as FileSystemDirectoryHandle
}
