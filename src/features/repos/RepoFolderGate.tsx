import { useLiveQuery } from 'dexie-react-hooks'
import { FolderOpen } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { db } from '../../db/db'
import { repoLabel } from '../../db/repos'
import type { OpenedRepo, Repo } from '../../db/schema'
import { supportsFileSystemAccess } from '../../fs/permission'
import { locateRepoFolder } from './openRepoFolder'
import { Panel } from '../../ui/Panel'
import { PermissionGate } from './PermissionGate'

interface RepoFolderGateProps {
  repo: Repo & { id: string }
  children: (repo: OpenedRepo) => ReactNode
}

/** Renders its children once this device has read access to the repo's folder; repos synced from elsewhere ask for it first. */
export function RepoFolderGate({ repo, children }: RepoFolderGateProps) {
  const local = useLiveQuery(async () => (await db.repoHandles.get(repo.id)) ?? null, [repo.id])
  if (local === undefined) return <p className="page muted">Loading…</p>
  if (local === null) return <LocateFolder repo={repo} />
  return <PermissionGate handle={local.dirHandle}>{children({ ...repo, dirHandle: local.dirHandle })}</PermissionGate>
}

function LocateFolder({ repo }: { repo: Repo }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const locate = async () => {
    setError(null)
    setBusy(true)
    try {
      await locateRepoFolder(repo)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="page narrow stack">
      <Panel icon={FolderOpen} title="open the checkout">
      <p>
        <strong>{repoLabel(repo)}</strong> was synced from another device. Open your checkout of it on this device to
        continue.
      </p>
      {error && <p className="error">{error}</p>}
      {supportsFileSystemAccess() && (
        <div>
          <button type="button" onClick={locate} disabled={busy}>
            <FolderOpen size={13} aria-hidden />
            {busy ? 'opening…' : 'open repo folder'}
          </button>
        </div>
      )}
      </Panel>
    </div>
  )
}
