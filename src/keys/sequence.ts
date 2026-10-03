export type SequenceResult =
  | { kind: 'match'; ids: string[] }
  | { kind: 'prefix' }
  | { kind: 'none' }

const startsWith = (sequence: readonly string[], prefix: readonly string[]) =>
  prefix.length <= sequence.length && prefix.every((token, index) => sequence[index] === token)

/**
 * Matches the tokens typed so far against every active sequence. A complete match wins;
 * otherwise, if some longer sequence starts with the tokens, wait for more.
 */
export function resolveSequence(typed: readonly string[], sequences: ReadonlyMap<string, readonly (readonly string[])[]>): SequenceResult {
  const ids: string[] = []
  let prefix = false
  for (const [id, options] of sequences) {
    for (const sequence of options) {
      if (sequence.length === typed.length && startsWith(sequence, typed)) {
        ids.push(id)
        break
      }
      if (sequence.length > typed.length && startsWith(sequence, typed)) prefix = true
    }
  }
  if (ids.length > 0) return { kind: 'match', ids }
  return prefix ? { kind: 'prefix' } : { kind: 'none' }
}
