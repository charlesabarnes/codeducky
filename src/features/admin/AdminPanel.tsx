import { RefreshCw, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { syncController, useSyncState } from '../../sync/client'
import { Panel } from '../../ui/Panel'
import { adminApi, errorMessage, statsLine, type AdminApi, type AdminStats, type AdminUser } from './adminApi'
import { UsersTable, type UserActions } from './UsersTable'
import './admin.css'

/** Account management for the built-in admin; renders nothing for anyone else. */
export function AdminPanel() {
  const { auth, user } = useSyncState()
  if (auth !== 'signedIn' || user?.role !== 'admin') return null
  return <AdminConsole api={api} />
}

const api = adminApi((method, path, body) => syncController.request(method, path, body))

function AdminConsole({ api }: { api: AdminApi }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState(0)
  const [version, setVersion] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    Promise.all([api.users(), api.stats()]).then(
      ([list, totals]) => {
        if (cancelled) return
        setUsers(list)
        setStats(totals)
        setLoadedAt(Date.now())
        setError(null)
        setLoading(false)
      },
      (err: unknown) => {
        if (cancelled) return
        setError(errorMessage(err))
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, version])

  const reload = () => {
    setLoading(true)
    setVersion((v) => v + 1)
  }

  const replace = (next: AdminUser) => setUsers((list) => list?.map((u) => (u.id === next.id ? next : u)) ?? null)

  const actions: UserActions = {
    disable: async (user) => replace(await api.disable(user.id)),
    enable: async (user) => replace(await api.enable(user.id)),
    remove: async (user) => {
      await api.remove(user.id)
      setUsers((list) => list?.filter((u) => u.id !== user.id) ?? null)
      api.stats().then(setStats, (err: unknown) => setError(errorMessage(err)))
    },
    setQuota: async (user, override) => replace(await api.setQuota(user.id, override)),
  }

  return (
    <Panel icon={ShieldCheck} title="admin" id="admin" className="admin-panel">
      <div className="row admin-stats">
        <span className="strong">{stats ? statsLine(stats) : 'loading…'}</span>
        <span className="spacer" />
        <button type="button" className="secondary" onClick={reload} disabled={loading}>
          <RefreshCw size={13} aria-hidden />
          refresh
        </button>
      </div>
      <p>
        Accounts and their usage. You can disable, delete or change the quota of an account, but never read its review data.
        Disabling signs the account out everywhere and revokes its tokens and connected apps.
      </p>
      {error && <p className="error">{error}</p>}
      {users && <UsersTable users={users} actions={actions} now={loadedAt} />}
    </Panel>
  )
}
