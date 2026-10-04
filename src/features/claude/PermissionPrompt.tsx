import { useState } from 'react'
import type { ChannelSessionView, PermissionBehavior, PermissionView } from '../../../shared/channel'
import { channelClient } from '../../channel/client'
import { HttpError } from '../../sync/api'

const ERRORS: Record<string, string> = {
  decided: 'Already answered.',
  disconnected: 'The Claude Code session is not connected; answer in its terminal.',
  not_found: 'This prompt is gone; it was probably answered in the terminal.',
}

/** A tool approval Claude Code relayed; the terminal dialog stays open, and whichever answer comes first wins. */
export function PermissionPrompt({ request, session }: { request: PermissionView; session?: ChannelSessionView }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const answer = async (behavior: PermissionBehavior) => {
    setBusy(true)
    setError(null)
    try {
      await channelClient.decide(request.channelId, request.requestId, behavior)
    } catch (err) {
      setError(err instanceof HttpError && err.code ? (ERRORS[err.code] ?? err.message) : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="claude-permission stack" role="alert">
      <p>
        <strong>Claude wants to use {request.toolName}</strong>
        {session && <span className="muted"> in {session.label}</span>}
        {request.description && <>: {request.description}</>}
      </p>
      {request.inputPreview && <pre className="mono claude-preview">{request.inputPreview}</pre>}
      <div className="row">
        <button type="button" disabled={busy} onClick={() => void answer('allow')}>
          Allow
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void answer('deny')}>
          Deny
        </button>
        <span className="muted">or answer in the terminal</span>
        {error && <span className="error">{error}</span>}
      </div>
    </div>
  )
}
