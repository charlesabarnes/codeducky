import { useLiveQuery } from 'dexie-react-hooks'
import { AppWindow, Bell, BellOff, BellRing, Download } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { db } from '../../db/db'
import { badgeApi, badgeCount } from '../../pwa/badge'
import { useInstallPrompt } from '../../pwa/installPrompt'
import { notificationPermission, showBrowserNotification } from '../../pwa/notifications'
import { presencePrefs, usePresencePrefs, type BadgeSource } from '../../pwa/presencePrefs'
import { pushController, pushServerKey, pushSupported } from '../../pwa/pushClient'
import { useSyncState } from '../../sync/client'
import { Panel } from '../../ui/Panel'
import './pwa.css'

/** Settings for how the app shows up outside its pages: installing it, its icon badge and notifications. */
export function PresencePanels() {
  return (
    <>
      <InstallPanel />
      <BadgePanel />
      <NotificationsPanel />
    </>
  )
}

function InstallPanel() {
  const { installed, available, prompt } = useInstallPrompt()
  const [declined, setDeclined] = useState(false)
  const install = async () => setDeclined((await prompt()) === 'dismissed')

  return (
    <Panel icon={AppWindow} title="install" id="install">
      {installed ? (
        <p className="ok-text">Code Ducky is installed on this device.</p>
      ) : (
        <>
          <p>
            Installed, Code Ducky opens in its own window, keeps folder access between launches, shows a badge on its icon and adds
            shortcuts to the inbox, repos and your last session.
          </p>
          {available ? (
            <div className="row">
              <button type="button" onClick={() => void install()}>
                <Download size={13} aria-hidden />
                install Code Ducky
              </button>
            </div>
          ) : (
            <p className="muted">
              {declined
                ? 'Install skipped. The browser offers it again later, or use Install in its address bar or menu.'
                : 'The browser has not offered to install it here. In Chrome or Edge, use Install in the address bar or the browser menu; in Safari, Add to Dock.'}
            </p>
          )}
        </>
      )}
    </Panel>
  )
}

const BADGE_LABELS: Record<BadgeSource, string> = { off: 'off', notes: 'open notes', requests: 'review requests' }
const BADGE_HINTS: Record<BadgeSource, string> = {
  off: 'No badge on the app icon.',
  notes: 'Open notes across your active sessions.',
  requests: 'Pull requests waiting for your review in the inbox.',
}

function BadgePanel() {
  const { badge } = usePresencePrefs()
  const count = useLiveQuery(() => badgeCount(db, badge), [badge])
  const supported = badgeApi() !== null

  return (
    <Panel icon={BellRing} title="app badge" id="badge">
      <p>The installed app's icon can show a count.</p>
      <div className="segmented inverted" role="group" aria-label="Badge count">
        {(Object.keys(BADGE_LABELS) as BadgeSource[]).map((source) => (
          <button key={source} type="button" aria-pressed={badge === source} onClick={() => presencePrefs.update({ badge: source })}>
            {BADGE_LABELS[source]}
          </button>
        ))}
      </div>
      <p className="muted">
        {BADGE_HINTS[badge]}
        {badge !== 'off' && count !== undefined && ` Now: ${count}.`}
        {!supported && ' This browser cannot badge app icons.'}
      </p>
    </Panel>
  )
}

const DEMO_NOTICE = {
  tag: 'demo',
  title: 'Notifications are on',
  body: 'Code Ducky will tell you when Claude finishes a task or a review is requested.',
  path: '/settings',
  quietOn: [],
}

function NotificationsPanel() {
  const prefs = usePresencePrefs()
  const navigate = useNavigate()
  const { auth } = useSyncState()
  const [permission, setPermission] = useState(notificationPermission)
  const [asking, setAsking] = useState(false)
  const on = prefs.notifications && permission === 'granted'

  // The permission prompt only ever comes from this click.
  const turnOn = async () => {
    setAsking(true)
    try {
      const result = permission === 'granted' ? permission : await Notification.requestPermission()
      setPermission(result)
      if (result === 'granted') {
        presencePrefs.update({ notifications: true })
        showBrowserNotification(DEMO_NOTICE, (path) => void navigate(path))
      }
    } finally {
      setAsking(false)
    }
  }

  const turnOff = async () => {
    presencePrefs.update({ notifications: false })
    await pushController.disable().catch((error: unknown) => console.warn('Could not unsubscribe from push', error))
  }

  return (
    <Panel icon={Bell} title="notifications" id="notifications">
      <p>
        Code Ducky can notify you while it is open, in a window or a tab, even in the background. Clicking one brings the app forward
        on the session.
      </p>
      {permission === 'unsupported' ? (
        <p className="muted">This browser cannot show notifications.</p>
      ) : permission === 'denied' ? (
        <p className="warn-text">Notifications are blocked for this site. Allow them in the browser's site settings, then turn them on here.</p>
      ) : !on ? (
        <div className="row">
          <button type="button" onClick={() => void turnOn()} disabled={asking}>
            <Bell size={13} aria-hidden />
            {asking ? 'asking…' : 'turn on notifications'}
          </button>
        </div>
      ) : (
        <>
          <div className="check-list">
            <label className="check-row">
              <input type="checkbox" checked={prefs.notifyTasks} onChange={(event) => presencePrefs.update({ notifyTasks: event.target.checked })} />
              <span>
                a "send to Claude" task is done or failed
                {auth !== 'signedIn' && <small className="muted"> (needs a signed-in Code Ducky server)</small>}
              </span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={prefs.notifyRequests}
                onChange={(event) => presencePrefs.update({ notifyRequests: event.target.checked })}
              />
              <span>
                a new review request reaches the inbox <small className="muted">(checked every few minutes)</small>
              </span>
            </label>
          </div>
          <PushOption signedIn={auth === 'signedIn'} />
          <div className="row">
            <button type="button" className="secondary" onClick={() => void turnOff()}>
              <BellOff size={13} aria-hidden />
              turn off
            </button>
          </div>
        </>
      )}
    </Panel>
  )
}

/** Whether the server has Web Push on: unknown until its key arrives. */
function useServerPush(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    void pushServerKey().then((key) => live && setEnabled(key !== null))
    return () => {
      live = false
    }
  }, [])
  return enabled
}

/** Web Push for this device, so the choices above also arrive while Code Ducky is closed. */
function PushOption({ signedIn }: { signedIn: boolean }) {
  const { push } = usePresencePrefs()
  const serverPush = useServerPush()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const unavailable = !pushSupported()
    ? 'This browser cannot receive push messages here; in Safari, install the app first.'
    : !signedIn
      ? 'Needs a signed-in Code Ducky server.'
      : serverPush === false
        ? 'The Code Ducky server has push turned off.'
        : null

  const toggle = async (on: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await (on ? pushController.enable() : pushController.disable())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not change push.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="check-list">
      <label className="check-row">
        <input
          type="checkbox"
          checked={push && !unavailable}
          disabled={busy || unavailable !== null || serverPush === null}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span>
          even when Code Ducky is closed <small className="muted">(this device)</small>
        </span>
      </label>
      {unavailable ? (
        <p className="muted">{unavailable}</p>
      ) : (
        <p className="muted">
          Push goes through your browser's push service. A request only arrives once a device with Code Ducky open refreshes the inbox.
        </p>
      )}
      {error && <p className="warn-text">{error}</p>}
    </div>
  )
}
