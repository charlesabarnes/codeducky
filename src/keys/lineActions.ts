import type { DiffSide } from '../diff/hunks'

export type NoteAction = 'edit' | 'resolve' | 'accept' | 'dismiss'

export interface ActionResult {
  /** Line key of the note acted on, so the cursor can follow it. */
  key: string
  message: string
}

/** What the diff's keyboard cursor can do with notes; supplied by the notes feature. */
export interface LineActions {
  /** Line keys that carry a visible note. */
  noted: ReadonlySet<string>
  comment: (side: DiffSide, line: number) => void
  /** Acts on the first suitable note on the given line keys (nearest first); null if none. */
  act: (action: NoteAction, keys: readonly string[]) => ActionResult | null
}

export function parseLineKey(key: string): { side: DiffSide; line: number } {
  const [side, line] = key.split(':')
  return { side: side === 'old' ? 'old' : 'new', line: Number(line) }
}
