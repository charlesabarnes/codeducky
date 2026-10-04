import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { db } from '../db/db'
import { lastSessionPath } from './lastSession'

/** The /last route: replaces itself with the session opened last on this device. */
export function LastSessionPage() {
  const navigate = useNavigate()
  useEffect(() => {
    lastSessionPath(db)
      .catch((error: unknown) => {
        console.warn('Could not find the last session', error)
        return '/'
      })
      .then((path) => navigate(path, { replace: true }))
  }, [navigate])
  return <p className="page muted">Opening your last session…</p>
}
