import type { FileChange } from '../../git/types'

/** git's short form for a rename: `src/{old.ts → new.ts}`, sharing leading and trailing folders. */
export function renameLabel(oldPath: string, newPath: string): string {
  let prefix = 0
  for (let i = 0; i < Math.min(oldPath.length, newPath.length) && oldPath[i] === newPath[i]; i++) {
    if (oldPath[i] === '/') prefix = i + 1
  }
  let suffix = 0
  const room = Math.min(oldPath.length, newPath.length) - prefix
  for (let i = 1; i <= room && oldPath[oldPath.length - i] === newPath[newPath.length - i]; i++) {
    if (oldPath[oldPath.length - i] === '/') suffix = i
  }
  const from = oldPath.slice(prefix, oldPath.length - suffix)
  const to = newPath.slice(prefix, newPath.length - suffix)
  if (prefix === 0 && suffix === 0) return `${oldPath} → ${newPath}`
  return `${newPath.slice(0, prefix)}{${from} → ${to}}${newPath.slice(newPath.length - suffix)}`
}

/** Old path → new path for every rename, so notes left on the old name follow the file. */
export function renamedPaths(files: readonly FileChange[] | null): Map<string, string> {
  return new Map((files ?? []).flatMap((file) => (file.oldPath ? [[file.oldPath, file.path] as const] : [])))
}

/** The path a note's file is listed under now. */
export const currentPath = (path: string, renamed: ReadonlyMap<string, string>) => renamed.get(path) ?? path
