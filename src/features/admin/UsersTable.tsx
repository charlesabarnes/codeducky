import { Ban, Check, Pencil, Trash2, UserCheck, X } from 'lucide-react'
import { Fragment, useState, type FormEvent } from 'react'
import { timeAgo } from '../pr/time'
import { Avatar } from '../sync/Avatar'
import { formatBytes } from '../sync/usage'
import { errorMessage, parseQuotaDraft, quotaDraft, tokenLine, type AdminUser, type QuotaDraft, type QuotaOverride } from './adminApi'

export interface UserActions {
  disable: (user: AdminUser) => Promise<void>
  enable: (user: AdminUser) => Promise<void>
  remove: (user: AdminUser) => Promise<void>
  setQuota: (user: AdminUser, override: QuotaOverride) => Promise<void>
}

export function UsersTable({ users, actions, now }: { users: AdminUser[]; actions: UserActions; now: number }) {
  return (
    <div className="admin-table-wrap">
      <table className="data-table admin-table">
        <thead>
          <tr>
            <th>account</th>
            <th>status</th>
            <th>storage</th>
            <th>access</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <UserRow key={user.id} user={user} actions={actions} now={now} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

type Mode = { kind: 'idle' } | { kind: 'confirm'; action: 'disable' | 'enable' | 'remove' } | { kind: 'quota' }

const ago = (at: number | null, now: number) => (at ? timeAgo(new Date(at).toISOString(), now) : 'never')

const CONFIRM_COPY = {
  disable: { verb: 'disable', icon: Ban, text: 'Signs @{login} out on every device and revokes their tokens and connected apps. Their data stays.' },
  enable: { verb: 'enable', icon: UserCheck, text: '@{login} can sign in again. Their old sessions and tokens stay revoked.' },
  remove: { verb: 'delete', icon: Trash2, text: 'Deletes @{login} and all of their review data on the server. It cannot be undone.' },
} as const

function UserRow({ user, actions, now }: { user: AdminUser; actions: UserActions; now: number }) {
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isAdmin = user.role === 'admin'
  const overridden = user.override.records !== null || user.override.bytes !== null

  const run = async (task: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await task()
      setMode({ kind: 'idle' })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Fragment>
      <tr className={user.status === 'disabled' ? 'disabled-account' : undefined}>
        <td>
          <span className="cell-icon account-cell">
            <Avatar user={user} size={18} />
            <span className="stack account-lines">
              <span>
                <strong>@{user.login}</strong>
                {user.name && <span className="muted"> {user.name}</span>}
              </span>
              <small className="muted">
                joined {ago(user.createdAt, now)} · seen {ago(user.lastSeenAt, now)}
              </small>
            </span>
          </span>
        </td>
        <td>
          {isAdmin ? (
            <span className="badge admin-badge">admin</span>
          ) : (
            <span className={`badge status-${user.status}`}>{user.status}</span>
          )}
        </td>
        <td>
          {isAdmin ? (
            <span className="muted">—</span>
          ) : (
            <span className="stack account-lines">
              <span>
                {formatBytes(user.usage.bytes)} <span className="muted">/ {formatBytes(user.quota.bytes)}</span>
              </span>
              <small className="muted">
                {user.usage.records.toLocaleString('en-US')} / {user.quota.records.toLocaleString('en-US')} records
                {overridden && <span className="override-mark"> · custom</span>}
              </small>
            </span>
          )}
        </td>
        <td>
          <span className="stack account-lines">
            <span>{tokenLine(user.tokens)}</span>
            <small className="muted">
              {user.grants} {user.grants === 1 ? 'app' : 'apps'} · {user.channelSessions} connected
            </small>
          </span>
        </td>
        <td className="num">
          {!isAdmin && mode.kind === 'idle' && (
            <span className="row admin-actions">
              <button type="button" className="link" onClick={() => setMode({ kind: 'quota' })} aria-label={`Edit quota for @${user.login}`}>
                <Pencil size={12} aria-hidden />
                quota
              </button>
              {user.status === 'active' ? (
                <button type="button" className="link danger" onClick={() => setMode({ kind: 'confirm', action: 'disable' })}>
                  <Ban size={12} aria-hidden />
                  disable
                </button>
              ) : (
                <button type="button" className="link" onClick={() => setMode({ kind: 'confirm', action: 'enable' })}>
                  <UserCheck size={12} aria-hidden />
                  enable
                </button>
              )}
              <button type="button" className="link danger" onClick={() => setMode({ kind: 'confirm', action: 'remove' })}>
                <Trash2 size={12} aria-hidden />
                delete
              </button>
            </span>
          )}
        </td>
      </tr>
      {mode.kind !== 'idle' && (
        <tr className="admin-detail">
          <td colSpan={5}>
            {mode.kind === 'confirm' ? (
              <ConfirmStep
                user={user}
                action={mode.action}
                busy={busy}
                onConfirm={() => void run(() => actions[mode.action](user))}
                onCancel={() => setMode({ kind: 'idle' })}
              />
            ) : (
              <QuotaEditor
                user={user}
                busy={busy}
                onSave={(override) => void run(() => actions.setQuota(user, override))}
                onCancel={() => setMode({ kind: 'idle' })}
              />
            )}
            {error && <p className="error">{error}</p>}
          </td>
        </tr>
      )}
    </Fragment>
  )
}

interface ConfirmStepProps {
  user: AdminUser
  action: 'disable' | 'enable' | 'remove'
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

function ConfirmStep({ user, action, busy, onConfirm, onCancel }: ConfirmStepProps) {
  const { verb, icon: Icon, text } = CONFIRM_COPY[action]
  const destructive = action !== 'enable'
  return (
    <div className="row admin-confirm">
      <span className="prompt" aria-hidden>
        &gt;
      </span>
      <span>
        <strong>
          {verb} @{user.login}?
        </strong>{' '}
        <span className="muted">{text.replace('{login}', user.login)}</span>
      </span>
      <span className="spacer" />
      <button type="button" className={destructive ? 'danger-button' : undefined} onClick={onConfirm} disabled={busy}>
        <Icon size={13} aria-hidden />
        {busy ? 'working…' : `yes, ${verb}`}
      </button>
      <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
        <X size={13} aria-hidden />
        cancel
      </button>
    </div>
  )
}

interface QuotaEditorProps {
  user: AdminUser
  busy: boolean
  onSave: (override: QuotaOverride) => void
  onCancel: () => void
}

function QuotaEditor({ user, busy, onSave, onCancel }: QuotaEditorProps) {
  const [draft, setDraft] = useState<QuotaDraft>(() => quotaDraft(user.override))
  const parsed = parseQuotaDraft(draft)
  const invalid = 'invalid' in parsed ? parsed.invalid : null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!('invalid' in parsed)) onSave(parsed)
  }

  return (
    <form className="row admin-quota" onSubmit={submit}>
      <span className="prompt" aria-hidden>
        &gt;
      </span>
      <strong>quota @{user.login}</strong>
      <label className="quota-field">
        <span className="muted">records</span>
        <input
          inputMode="numeric"
          value={draft.records}
          placeholder="default"
          aria-invalid={invalid === 'records'}
          onChange={(e) => setDraft({ ...draft, records: e.target.value })}
        />
      </label>
      <label className="quota-field">
        <span className="muted">MB</span>
        <input
          inputMode="decimal"
          value={draft.megabytes}
          placeholder="default"
          aria-invalid={invalid === 'megabytes'}
          onChange={(e) => setDraft({ ...draft, megabytes: e.target.value })}
        />
      </label>
      <span className="spacer" />
      <button type="submit" disabled={busy || invalid !== null}>
        <Check size={13} aria-hidden />
        {busy ? 'saving…' : 'save'}
      </button>
      <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
        <X size={13} aria-hidden />
        cancel
      </button>
      <small className="muted quota-hint">Blank uses the server default.</small>
    </form>
  )
}
