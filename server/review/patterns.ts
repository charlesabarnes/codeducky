import type { NoteRecord } from '../mcp/records'

export interface RecurringPattern {
  title: string
  count: number
  severity: NoteRecord['severity']
  /** A resolution reply from one of the occurrences, if any. */
  example?: string
}

export interface RecurringKeyword {
  keyword: string
  count: number
}

const STOPWORDS = new Set(
  `a an and are as at be but by can do does for from has have if in into is it its not of on or so that the then there these
  this to was we were when which while will with without you your should would could use used using also only than more
  less just like need needs here line lines code file files add added remove removed make makes call calls one two new old
  get set value values may might it's don't isn't`.split(/\s+/),
)

const normalizeTitle = (text: string) =>
  text
    .replace(/[*_`#>]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.:;,!]+$/, '')
    .toLowerCase()

/** A note's headline: its title, else the first line of the body without markdown emphasis. */
export function headline(note: Pick<NoteRecord, 'title' | 'body'>): string {
  const first = (note.title?.trim() || note.body.split('\n').find((line) => line.trim()) || '').trim()
  return first.replace(/[*_`#>]/g, '').trim().slice(0, 200)
}

function keywords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []
  return new Set(words.filter((word) => !STOPWORDS.has(word)))
}

/**
 * What keeps coming up in this repo's resolved notes: headlines that repeat, and the words that
 * appear in the most notes. Plain frequency counts; anything seen only once is left out.
 */
export function recurringPatterns(resolved: readonly NoteRecord[], limit = 10) {
  const byTitle = new Map<string, { title: string; notes: NoteRecord[] }>()
  const byWord = new Map<string, number>()
  for (const note of resolved) {
    const title = headline(note)
    if (!title) continue
    const key = normalizeTitle(title)
    const group = byTitle.get(key) ?? { title, notes: [] }
    group.notes.push(note)
    byTitle.set(key, group)
    for (const word of keywords(`${note.title ?? ''} ${note.body}`)) byWord.set(word, (byWord.get(word) ?? 0) + 1)
  }

  const titles: RecurringPattern[] = [...byTitle.values()]
    .filter((group) => group.notes.length > 1)
    .sort((a, b) => b.notes.length - a.notes.length || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(({ title, notes }) => {
      const example = notes.find((note) => note.resolution?.text)?.resolution?.text
      return { title, count: notes.length, severity: notes[0]!.severity, ...(example ? { example: example.slice(0, 300) } : {}) }
    })
  const words: RecurringKeyword[] = [...byWord.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([keyword, count]) => ({ keyword, count }))
  return { resolvedNotes: resolved.length, titles, keywords: words }
}
