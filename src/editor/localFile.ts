import { FsError } from '../fs/errors'
import { splitPath } from '../fs/path'
import { hasWritePermission, requestWritePermission } from '../fs/permission'
import { hashBlob } from '../git/hash'
import { DEFAULT_MAX_BYTES, isBinary } from '../git/sides'
import { decodeText, encodeText, type TextFormat } from './textFormat'

/** What the file on disk was when the editor read or wrote it, to notice changes made elsewhere. */
export interface DiskVersion {
  lastModified: number
  size: number
  oid: string
}

export interface TextFile {
  text: string
  format: TextFormat
  version: DiskVersion
}

export type ReadResult =
  | { kind: 'text'; file: TextFile }
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number }
  | { kind: 'missing' }

export type SaveResult =
  | { kind: 'saved'; version: DiskVersion }
  /** The folder is read-only so far; ask again with `allowPrompt` from a click. */
  | { kind: 'needs-permission' }
  | { kind: 'denied' }
  /** The file changed on disk since it was read; `disk` is its new text, when it still is text. */
  | { kind: 'conflict'; deleted: boolean; disk: TextFile | null }

export interface SaveOptions {
  format: TextFormat
  /** The version the edits started from. */
  expected: DiskVersion
  /** Write even when the file changed on disk. */
  force?: boolean
  /** Show the browser's permission prompt when the folder is still read-only. */
  allowPrompt?: boolean
}

function domName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : undefined
}

async function fileHandle(root: FileSystemDirectoryHandle, path: string, create = false): Promise<FileSystemFileHandle | null> {
  const segments = splitPath(path)
  const name = segments.pop()
  if (!name) throw new FsError('EISDIR', 'open', path)
  try {
    let dir = root
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create })
    return await dir.getFileHandle(name, { create })
  } catch (error) {
    if (domName(error) === 'NotFoundError') return null
    if (domName(error) === 'TypeMismatchError') throw new FsError('EISDIR', 'open', path)
    throw error
  }
}

async function versionOf(file: File, bytes: Uint8Array): Promise<DiskVersion> {
  return { lastModified: file.lastModified, size: file.size, oid: await hashBlob(bytes) }
}

async function readHandle(handle: FileSystemFileHandle, maxBytes: number): Promise<ReadResult> {
  const file = await handle.getFile()
  if (file.size > maxBytes) return { kind: 'too-large', size: file.size }
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (isBinary(bytes)) return { kind: 'binary' }
  return { kind: 'text', file: { ...decodeText(bytes), version: await versionOf(file, bytes) } }
}

/** Reads a working-tree file for editing. */
export async function readLocalFile(root: FileSystemDirectoryHandle, path: string, maxBytes = DEFAULT_MAX_BYTES): Promise<ReadResult> {
  const handle = await fileHandle(root, path)
  return handle ? readHandle(handle, maxBytes) : { kind: 'missing' }
}

/** Whether the file still holds what `expected` describes; a new mtime alone (a touch) is not a change. */
async function unchanged(handle: FileSystemFileHandle, expected: DiskVersion): Promise<boolean> {
  const file = await handle.getFile()
  if (file.lastModified === expected.lastModified && file.size === expected.size) return true
  if (file.size !== expected.size) return false
  return (await hashBlob(new Uint8Array(await file.arrayBuffer()))) === expected.oid
}

async function ensureWritable(root: FileSystemDirectoryHandle, allowPrompt: boolean): Promise<SaveResult | null> {
  if (await hasWritePermission(root)) return null
  if (!allowPrompt) return { kind: 'needs-permission' }
  return (await requestWritePermission(root)) ? null : { kind: 'denied' }
}

/** Writes the editor's text to the working tree, refusing to overwrite changes made elsewhere unless forced. */
export async function saveLocalFile(root: FileSystemDirectoryHandle, path: string, text: string, options: SaveOptions): Promise<SaveResult> {
  const refused = await ensureWritable(root, options.allowPrompt ?? false)
  if (refused) return refused
  const existing = await fileHandle(root, path)
  if (!options.force) {
    if (!existing) return { kind: 'conflict', deleted: true, disk: null }
    if (!(await unchanged(existing, options.expected))) {
      const disk = await readHandle(existing, Number.POSITIVE_INFINITY)
      return { kind: 'conflict', deleted: false, disk: disk.kind === 'text' ? disk.file : null }
    }
  }
  const handle = existing ?? (await fileHandle(root, path, true))
  if (!handle) throw new FsError('ENOENT', 'open', path)
  const bytes = encodeText(text, options.format)
  const writable = await handle.createWritable()
  try {
    await writable.write(bytes as Uint8Array<ArrayBuffer>)
    await writable.close()
  } catch (error) {
    await writable.abort().catch(() => undefined)
    throw error
  }
  return { kind: 'saved', version: await versionOf(await handle.getFile(), bytes) }
}
