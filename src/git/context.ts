import type { HandleFs } from '../fs/handleFs'

export interface GitContext {
  fs: HandleFs
  dir: string
  gitdir: string
  cache: object
  /** Base blobs supplied from outside the repository (the GitHub API), keyed by oid. */
  blobs: Map<string, Uint8Array>
}

export function createContext(fs: HandleFs, blobs = new Map<string, Uint8Array>()): GitContext {
  return { fs, dir: '/', gitdir: '/.git', cache: {}, blobs }
}
