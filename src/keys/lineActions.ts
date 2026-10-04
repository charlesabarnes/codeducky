import type { DiffSide } from '../diff/hunks'
import type { LineRange } from './selection'

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
  /** Opens the note editor on a line or a range of lines. */
  comment: (range: LineRange) => void
  /** Acts on the first suitable note on the given line keys (nearest first); null if none. */
  act: (action: NoteAction, keys: readonly string[]) => ActionResult | null
}

export function parseLineKey(key: string): { side: DiffSide; line: number } {
  const [side, line] = key.split(':')
  return { side: side === 'old' ? 'old' : 'new', line: Number(line) }
}
