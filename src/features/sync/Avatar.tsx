import { UserRound } from 'lucide-react'
import { useState } from 'react'
import type { SessionUser } from '../../sync/meta'

/** The GitHub avatar, or a plain glyph for the admin account and when the image cannot load. */
export function Avatar({ user, size = 16 }: { user: SessionUser; size?: number }) {
  const [failed, setFailed] = useState(false)
  if (!user.avatarUrl || failed) return <UserRound size={size} aria-hidden className="avatar avatar-glyph" />
  return <img className="avatar" src={user.avatarUrl} alt="" width={size} height={size} onError={() => setFailed(true)} />
}
