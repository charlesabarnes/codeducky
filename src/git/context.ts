import type { HandleFs } from '../fs/handleFs'

export interface GitContext {
  fs: HandleFs
  dir: string
  gitdir: string
  cache: object
}

export function createContext(fs: HandleFs): GitContext {
  return { fs, dir: '/', gitdir: '/.git', cache: {} }
}
