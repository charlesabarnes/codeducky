const SAMPLE_LINES = 2000

/** The file's indent unit, guessed from its lines: a tab, or the most common step between space indents. */
export function detectIndent(text: string, fallback = '  '): string {
  let tabs = 0
  let spaced = 0
  const steps = new Map<number, number>()
  let previous = 0
  for (const line of text.split('\n', SAMPLE_LINES)) {
    if (!line.trim()) continue
    if (line.startsWith('\t')) {
      tabs++
      continue
    }
    const width = line.length - line.trimStart().length
    if (width > 0) spaced++
    const step = Math.abs(width - previous)
    if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1)
    previous = width
  }
  if (tabs > spaced) return '\t'
  let best = 0
  let count = 0
  for (const [step, seen] of steps) {
    if (seen > count || (seen === count && step < best)) {
      best = step
      count = seen
    }
  }
  return best ? ' '.repeat(best) : fallback
}
