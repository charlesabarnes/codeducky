import type { FileView } from '../db/schema'
import type { FileChange } from '../git/types'

export function contentHash(change: Pick<FileChange, 'oldOid' | 'newOid'>): string {
  return `${change.oldOid ?? '0'}:${change.newOid ?? '0'}`
}

export function isViewed(view: FileView | undefined, hash: string): boolean {
  return Boolean(view?.viewed && view.contentHash === hash)
}

export function viewedPaths(files: readonly FileChange[], views: readonly FileView[]): Set<string> {
  const byPath = new Map(views.map((view) => [view.path, view]))
  return new Set(files.filter((file) => isViewed(byPath.get(file.path), contentHash(file))).map((file) => file.path))
}
