import type { SkelbertDb } from './db'
import type { Settings } from './schema'

export type SettingsInput = Omit<Settings, 'id'>

export const defaultSettings: Settings = { id: 'app', githubPat: '' }

export async function loadSettings(db: SkelbertDb): Promise<Settings> {
  const stored = await db.settings.get('app')
  return stored ? { id: 'app', githubPat: stored.githubPat ?? '' } : defaultSettings
}

export async function saveSettings(db: SkelbertDb, input: SettingsInput): Promise<void> {
  await db.settings.put({ id: 'app', githubPat: input.githubPat.trim() })
}
