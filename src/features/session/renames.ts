import type { FileChange } from '../../git/types'

export interface PathParts {
  dir: string
  name: string
}

/** A path as folders and name; for a rename the name is git's short form, `{old.ts → new.ts}` and whatever follows it. */
export function pathParts(path: string, oldPath?: string): PathParts {
  if (!oldPath) {
    const cut = path.lastIndexOf('/') + 1
    return { dir: path.slice(0, cut), name: path.slice(cut) }
  }
  let prefix = 0
  for (let i = 0; i < Math.min(oldPath.length, path.length) && oldPath[i] === path[i]; i++) {
    if (oldPath[i] === '/') prefix = i + 1
  }
  let suffix = 0
  const room = Math.min(oldPath.length, path.length) - prefix
  for (let i = 1; i <= room && oldPath[oldPath.length - i] === path[path.length - i]; i++) {
    if (oldPath[oldPath.length - i] === '/') suffix = i
  }
  if (prefix === 0 && suffix === 0) return { dir: '', name: `${oldPath} → ${path}` }
  const from = oldPath.slice(prefix, oldPath.length - suffix)
  const to = path.slice(prefix, path.length - suffix)
  return { dir: path.slice(0, prefix), name: `{${from} → ${to}}${path.slice(path.length - suffix)}` }
}

/** Old path → new path for every rename, so notes left on the old name follow the file. */
export function renamedPaths(files: readonly FileChange[] | null): Map<string, string> {
  return new Map((files ?? []).flatMap((file) => (file.oldPath ? [[file.oldPath, file.path] as const] : [])))
}

/** The path a note's file is listed under now. */
export const currentPath = (path: string, renamed: ReadonlyMap<string, string>) => renamed.get(path) ?? path
