export function splitPath(path: string): string[] {
  const parts: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts
}

export function normalizePath(path: string): string {
  return '/' + splitPath(path).join('/')
}
