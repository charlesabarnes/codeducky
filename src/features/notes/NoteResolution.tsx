import type { NoteResolution as Resolution } from '../../db/schema'
import '../sync/sync.css'
import { Markdown } from './Markdown'

export function NoteResolution({ resolution }: { resolution: Resolution }) {
  return (
    <section className="note-resolution">
      <header>
        Resolved by {resolution.by} · {new Date(resolution.at).toLocaleString()}
      </header>
      <Markdown text={resolution.text} />
    </section>
  )
}
