import type { Note } from '../../db/schema'
import { noteExcerpt } from '../../review/report'

export function AnchorExcerpt({ note }: { note: Note }) {
  return <pre className="excerpt">{noteExcerpt(note)}</pre>
}
