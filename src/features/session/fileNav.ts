/** Files whose path contains every whitespace-separated term, case-insensitively. */
export function filterFiles<T extends { path: string }>(files: readonly T[], query: string): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...files]
  return files.filter((file) => {
    const path = file.path.toLowerCase()
    return terms.every((term) => path.includes(term))
  })
}

/**
 * The next (or previous) path in list order, skipping any the predicate rejects. Starts from
 * the ends when the current path is not in the list (e.g. hidden by the filter). No wrapping.
 */
export function stepFile(
  paths: readonly string[],
  current: string | null,
  delta: 1 | -1,
  skip: (path: string) => boolean = () => false,
): string | null {
  const index = current === null ? -1 : paths.indexOf(current)
  const start = index >= 0 ? index + delta : delta > 0 ? 0 : paths.length - 1
  for (let i = start; i >= 0 && i < paths.length; i += delta) {
    if (!skip(paths[i]!)) return paths[i]!
  }
  return null
}

/** The next unviewed path after the current one, wrapping around, never the current one. */
export function nextUnviewed(paths: readonly string[], current: string | null, viewed: ReadonlySet<string>): string | null {
  const index = current === null ? -1 : paths.indexOf(current)
  for (let offset = 1; offset <= paths.length; offset++) {
    const path = paths[(index + offset + paths.length) % paths.length]!
    if (path !== current && !viewed.has(path)) return path
  }
  return null
}
