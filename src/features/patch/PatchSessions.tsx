import { useLiveQuery } from 'dexie-react-hooks'
import { FileDiff, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { sessionPath } from '../../../shared/links'
import { db } from '../../db/db'
import { patchSessions, removePatchSession } from '../../db/patchSessions'
import { errorMessage } from '../../github/errors'
import { openPatchFiles, PATCH_EXTENSIONS } from './openPatch'

/** "Open .patch file" through a file picker, so it works in any browser, installed or not. */
export function OpenPatchButton({ onError }: { onError: (message: string | null) => void }) {
  const navigate = useNavigate()
  const input = useRef<HTMLInputElement>(null)
  const [opening, setOpening] = useState(false)

  const open = async (files: FileList | null) => {
    if (!files?.length) return
    onError(null)
    setOpening(true)
    try {
      const sessionId = await openPatchFiles(db, [...files])
      if (sessionId) void navigate(sessionPath(sessionId))
    } catch (error) {
      onError(errorMessage(error))
    } finally {
      setOpening(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <>
      <button type="button" className="secondary" onClick={() => input.current?.click()} disabled={opening} title="Review a .diff or .patch file; it stays on this device">
        <FileDiff size={13} aria-hidden />
        {opening ? 'opening…' : 'open .patch file'}
      </button>
      <input ref={input} type="file" accept={PATCH_EXTENSIONS} hidden onChange={(event) => void open(event.target.files)} />
    </>
  )
}

/** The patches opened on this device. */
export function PatchSessionList() {
  const sessions = useLiveQuery(() => patchSessions(db), [])
  if (!sessions?.length) return null
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th className="caret" />
          <th>patch</th>
          <th className="col-fixed">opened</th>
          <th className="col-fixed" />
        </tr>
      </thead>
      <tbody>
        {sessions.map((session) => (
          <tr key={session.id}>
            <td className="caret" />
            <td>
              <span className="cell-icon">
                <FileDiff size={13} aria-hidden />
                <Link className="repo-link" to={sessionPath(session.id!)}>
                  {session.branch}
                </Link>
              </span>
            </td>
            <td className="muted">{new Date(session.startedAt).toLocaleDateString()}</td>
            <td>
              <button
                type="button"
                className="link muted"
                aria-label={`Remove ${session.branch} and its notes`}
                title="Remove the patch and its notes from this device"
                onClick={() => {
                  if (window.confirm(`Remove ${session.branch} and its notes from this device?`)) void removePatchSession(db, session.id!)
                }}
              >
                <Trash2 size={13} aria-hidden />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
