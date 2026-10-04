export interface MemoryTree {
  [name: string]: string | Uint8Array | MemoryTree
}

export interface MemoryOptions {
  lastModified?: number
  /** Permission per mode before any request; read is granted by default, readwrite too. */
  permissions?: Partial<Record<FileSystemPermissionMode, PermissionState>>
  /** What the browser's prompt answers to requestPermission. */
  answer?: PermissionState
  /** The time a write is stamped with. */
  now?: () => number
}

const encoder = new TextEncoder()

interface Shared {
  permissions: Record<FileSystemPermissionMode, PermissionState>
  answer: PermissionState
  now: () => number
  requests: FileSystemPermissionMode[]
}

class MemoryFileHandle {
  readonly kind = 'file'
  readonly name: string
  private bytes: Uint8Array
  private lastModified: number
  private readonly shared: Shared

  constructor(name: string, bytes: Uint8Array, lastModified: number, shared: Shared) {
    this.name = name
    this.bytes = bytes
    this.lastModified = lastModified
    this.shared = shared
  }

  async getFile(): Promise<File> {
    return new File([this.bytes as Uint8Array<ArrayBuffer>], this.name, { lastModified: this.lastModified })
  }

  /** Changes the file as another program would. */
  replace(content: string | Uint8Array, lastModified = this.shared.now()): void {
    this.bytes = typeof content === 'string' ? encoder.encode(content) : content
    this.lastModified = lastModified
  }

  async createWritable() {
    if (this.shared.permissions.readwrite !== 'granted') throw new DOMException('Not allowed', 'NotAllowedError')
    let pending: Uint8Array = new Uint8Array()
    return {
      write: async (data: Uint8Array) => {
        pending = data
      },
      close: async () => this.replace(pending),
      abort: async () => undefined,
    }
  }
}

class MemoryDirectoryHandle {
  readonly kind = 'directory'
  readonly name: string
  private readonly children = new Map<string, MemoryFileHandle | MemoryDirectoryHandle>()
  private readonly shared: Shared

  constructor(name: string, tree: MemoryTree, lastModified: number, shared: Shared) {
    this.name = name
    this.shared = shared
    for (const [childName, value] of Object.entries(tree)) {
      this.children.set(
        childName,
        typeof value === 'string' || value instanceof Uint8Array
          ? new MemoryFileHandle(childName, typeof value === 'string' ? encoder.encode(value) : value, lastModified, shared)
          : new MemoryDirectoryHandle(childName, value, lastModified, shared),
      )
    }
  }

  async *entries(): AsyncIterableIterator<[string, MemoryFileHandle | MemoryDirectoryHandle]> {
    yield* this.children.entries()
  }

  async queryPermission({ mode = 'read' }: FileSystemHandlePermissionDescriptor = {}): Promise<PermissionState> {
    return this.shared.permissions[mode]
  }

  async requestPermission({ mode = 'read' }: FileSystemHandlePermissionDescriptor = {}): Promise<PermissionState> {
    this.shared.requests.push(mode)
    if (this.shared.permissions[mode] === 'prompt') this.shared.permissions[mode] = this.shared.answer
    return this.shared.permissions[mode]
  }

  async getFileHandle(name: string, { create = false }: FileSystemGetFileOptions = {}): Promise<MemoryFileHandle> {
    let child = this.children.get(name)
    if (!child && create) {
      child = new MemoryFileHandle(name, new Uint8Array(), this.shared.now(), this.shared)
      this.children.set(name, child)
    }
    if (!child) throw new DOMException(`${name} not found`, 'NotFoundError')
    if (child.kind !== 'file') throw new DOMException(`${name} is a directory`, 'TypeMismatchError')
    return child
  }

  async getDirectoryHandle(name: string, { create = false }: FileSystemGetDirectoryOptions = {}): Promise<MemoryDirectoryHandle> {
    let child = this.children.get(name)
    if (!child && create) {
      child = new MemoryDirectoryHandle(name, {}, this.shared.now(), this.shared)
      this.children.set(name, child)
    }
    if (!child) throw new DOMException(`${name} not found`, 'NotFoundError')
    if (child.kind !== 'directory') throw new DOMException(`${name} is a file`, 'TypeMismatchError')
    return child
  }

  async removeEntry(name: string): Promise<void> {
    this.children.delete(name)
  }
}

export interface MemoryRoot {
  handle: FileSystemDirectoryHandle
  /** Permission requests made so far, by mode. */
  requests: FileSystemPermissionMode[]
  file(path: string): Promise<MemoryFileHandle>
  /** Deletes a file as another program would. */
  remove(path: string): Promise<void>
}

export function memoryRoot(tree: MemoryTree, options: MemoryOptions = {}): MemoryRoot {
  const shared: Shared = {
    permissions: { read: 'granted', readwrite: 'granted', ...options.permissions },
    answer: options.answer ?? 'granted',
    now: options.now ?? (() => Date.now()),
    requests: [],
  }
  const root = new MemoryDirectoryHandle('root', tree, options.lastModified ?? 1_700_000_000_000, shared)
  const parent = async (path: string) => {
    const parts = path.split('/')
    let dir = root
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part)
    return { dir, name: parts.at(-1)! }
  }
  return {
    handle: root as unknown as FileSystemDirectoryHandle,
    requests: shared.requests,
    async file(path) {
      const { dir, name } = await parent(path)
      return dir.getFileHandle(name)
    },
    async remove(path) {
      const { dir, name } = await parent(path)
      await dir.removeEntry(name)
    },
  }
}

export function memoryDirectoryHandle(tree: MemoryTree, lastModified = 1_700_000_000_000): FileSystemDirectoryHandle {
  return memoryRoot(tree, { lastModified }).handle
}
