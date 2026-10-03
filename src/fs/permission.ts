const READ: FileSystemHandlePermissionDescriptor = { mode: 'read' }

export async function hasReadPermission(handle: FileSystemHandle): Promise<boolean> {
  return (await handle.queryPermission(READ)) === 'granted'
}

export async function requestReadPermission(handle: FileSystemHandle): Promise<boolean> {
  return (await hasReadPermission(handle)) || (await handle.requestPermission(READ)) === 'granted'
}

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}
