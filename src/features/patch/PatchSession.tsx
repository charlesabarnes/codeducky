import { Link } from 'react-router'
import { patchRepo } from '../../db/patchSessions'
import type { Session } from '../../db/schema'
import { SessionView } from '../session/SessionView'
import { usePatchSource } from './usePatchSource'

/** A review session over a patch file: read-only, with notes kept on this device. */
export function PatchSession({ session }: { session: Session }) {
  const source = usePatchSource(session)
  if (source === undefined) return <p className="page muted">Loading…</p>
  if (source === null) return <MissingPatch />
  return <SessionView session={session} repo={patchRepo(session)} source={source} dirHandle={null} pr={null} />
}

export function MissingPatch() {
  return (
    <section className="page narrow stack">
      <h1>The patch file is gone</h1>
      <p>Patch sessions keep their file on the device that opened it. Open the .patch file again to review it here.</p>
      <p>
        <Link to="/">Repos</Link>
      </p>
    </section>
  )
}
