import type { HandleFs } from '../fs/handleFs'
import { splitPath } from '../fs/path'
import type { IgnoreRules } from './ignore'

export function trackedPaths(indexPaths: string[]): Set<string> {
  const tracked = new Set<string>()
  for (const path of indexPaths) {
    const parts = path.split('/')
    for (let depth = 1; depth <= parts.length; depth++) tracked.add(parts.slice(0, depth).join('/'))
  }
  return tracked
}

/**
 * A view of the fs whose working-tree listings omit `.git` and untracked ignored entries,
 * so walks never descend into directories such as node_modules.
 */
export function workdirView(fs: HandleFs, tracked: Set<string>, ignoreRules: IgnoreRules) {
  const readdir = async (path: string): Promise<string[]> => {
    const parts = splitPath(path)
    if (parts[0] === '.git') return fs.promises.readdir(path)
    const parent = parts.join('/')
    const visible: string[] = []
    for (const { name, kind } of await fs.readdirTyped(path)) {
      const child = parent ? `${parent}/${name}` : name
      if (child === '.git') continue
      if (tracked.has(child) || !(await ignoreRules.isIgnored(child, kind === 'directory'))) visible.push(child)
    }
    return visible.map((child) => child.slice(child.lastIndexOf('/') + 1))
  }
  return { promises: { ...fs.promises, readdir } }
}
