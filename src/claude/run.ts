import { db } from '../db/db'
import { addSuggestions } from '../db/suggestions'
import { gitService } from '../git/client'
import type { FileChange } from '../git/types'
import { chunkReviewer, createClaudeClient } from './client'
import { describeClaudeError } from './errors'
import { runPass, type PassProgress } from './pass'
import type { UsageTotals } from './pricing'
import { systemPrompt } from './prompt'

export interface StartPass {
  sessionId: number
  apiKey: string
  model: string
  instructions?: string
  files: FileChange[]
  signal: AbortSignal
  onProgress: (progress: PassProgress) => void
  usage?: UsageTotals
}

/** Browser entry point, loaded lazily so the SDK stays out of the main bundle. */
export function startClaudePass({ sessionId, apiKey, model, instructions, files, signal, onProgress, usage }: StartPass) {
  const client = createClaudeClient({ apiKey })
  return runPass(
    files,
    {
      loadContents: (file) => gitService().contents(file),
      review: chunkReviewer(client, model, systemPrompt(instructions)),
      save: (drafts) => addSuggestions(db, sessionId, drafts),
      describe: (error) => describeClaudeError(error, model),
    },
    { signal, onProgress, usage },
  )
}
