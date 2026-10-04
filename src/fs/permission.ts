const READ: FileSystemHandlePermissionDescriptor = { mode: 'read' }
const WRITE: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' }

export async function hasReadPermission(handle: FileSystemHandle): Promise<boolean> {
  return (await handle.queryPermission(READ)) === 'granted'
}

export async function requestReadPermission(handle: FileSystemHandle): Promise<boolean> {
  return (await hasReadPermission(handle)) || (await handle.requestPermission(READ)) === 'granted'
}

/** Folders are opened read-only; saving from the editor upgrades the handle the first time. */
export async function hasWritePermission(handle: FileSystemHandle): Promise<boolean> {
  return (await handle.queryPermission(WRITE)) === 'granted'
}

/** Must run in a user gesture: the browser shows its own prompt. */
export async function requestWritePermission(handle: FileSystemHandle): Promise<boolean> {
  return (await hasWritePermission(handle)) || (await handle.requestPermission(WRITE)) === 'granted'
}

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}
