import type { CodeDuckyDb } from './db'

/** Suggested notes arrive over MCP; the owner accepts them into open notes or dismisses them. */
export async function acceptSuggestion(db: CodeDuckyDb, id: string): Promise<void> {
  await db.notes.update(id, { status: 'open', updatedAt: Date.now() })
}

export async function dismissSuggestion(db: CodeDuckyDb, id: string): Promise<void> {
  await db.notes.update(id, { status: 'dismissed', updatedAt: Date.now() })
}

export async function restoreSuggestion(db: CodeDuckyDb, id: string): Promise<void> {
  await db.notes.update(id, { status: 'suggested', updatedAt: Date.now() })
}
