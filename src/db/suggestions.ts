import { suggestionKey, type SuggestionDraft } from '../claude/findings'
import type { SkelbertDb } from './db'
import type { Note } from './schema'

export interface SaveResult {
  added: number
  duplicates: number
}

/** Saves Claude findings as suggested notes, skipping any whose anchor and title match a note already in the session. */
export async function addSuggestions(db: SkelbertDb, sessionId: number, drafts: readonly SuggestionDraft[]): Promise<SaveResult> {
  if (drafts.length === 0) return { added: 0, duplicates: 0 }
  return db.transaction('rw', db.notes, async () => {
    const existing = await db.notes.where({ sessionId }).toArray()
    const seen = new Set(existing.map(suggestionKey))
    const now = Date.now()
    const fresh: Note[] = []
    for (const draft of drafts) {
      const key = suggestionKey(draft)
      if (seen.has(key)) continue
      seen.add(key)
      fresh.push({ ...draft, sessionId, status: 'suggested', source: 'claude', createdAt: now, updatedAt: now })
    }
    if (fresh.length > 0) await db.notes.bulkAdd(fresh)
    return { added: fresh.length, duplicates: drafts.length - fresh.length }
  })
}

export async function acceptSuggestion(db: SkelbertDb, id: number): Promise<void> {
  await db.notes.update(id, { status: 'open', updatedAt: Date.now() })
}

export async function dismissSuggestion(db: SkelbertDb, id: number): Promise<void> {
  await db.notes.update(id, { status: 'dismissed', updatedAt: Date.now() })
}

export async function restoreSuggestion(db: SkelbertDb, id: number): Promise<void> {
  await db.notes.update(id, { status: 'suggested', updatedAt: Date.now() })
}

export async function saveRepoInstructions(db: SkelbertDb, repoId: number, instructions: string): Promise<void> {
  await db.repos.update(repoId, { claudeInstructions: instructions.trim() })
}
