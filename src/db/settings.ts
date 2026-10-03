import type { SkelbertDb } from './db'
import type { Settings } from './schema'

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'

export type SettingsInput = Omit<Settings, 'id'>

export const defaultSettings: Settings = {
  id: 'app',
  githubPat: '',
  anthropicKey: '',
  claudeModel: DEFAULT_CLAUDE_MODEL,
}

export async function loadSettings(db: SkelbertDb): Promise<Settings> {
  return (await db.settings.get('app')) ?? defaultSettings
}

export async function saveSettings(db: SkelbertDb, input: SettingsInput): Promise<void> {
  await db.settings.put({
    id: 'app',
    githubPat: input.githubPat.trim(),
    anthropicKey: input.anthropicKey.trim(),
    claudeModel: input.claudeModel.trim() || DEFAULT_CLAUDE_MODEL,
  })
}
