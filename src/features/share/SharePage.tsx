import { Share2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { prPath } from '../../../shared/links'
import { StatusBar } from '../../app/chrome'
import { githubClient } from '../../github/connect'
import { errorMessage } from '../../github/errors'
import { SHARE_FIELDS, sharedLink, type CompareRef } from '../../pwa/share'
import { PageHeader } from '../../ui/PageHeader'
import './share.css'

/**
 * The manifest's share target (/share?url=…&text=…&title=…): a shared pull request opens as a session, a compare
 * opens the pull request from its head branch, and anything else gets a page that says what Code Ducky takes.
 */
export function SharePage() {
  const [params] = useSearchParams()
  const link = sharedLink(params)
  if (link?.kind === 'pr') return <Navigate to={prPath(link.pull)} replace />
  if (link?.kind === 'compare') return <OpenCompare compare={link.compare} />
  return <Unrecognised shared={SHARE_FIELDS.map((field) => params.get(field)?.trim()).filter((value): value is string => !!value)} />
}

type CompareState = { status: 'loading' } | { status: 'no-token' } | { status: 'no-pull' } | { status: 'error'; message: string }

function OpenCompare({ compare }: { compare: CompareRef }) {
  const navigate = useNavigate()
  const [state, setState] = useState<CompareState>({ status: 'loading' })
  const { owner, name, head, headOwner } = compare

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const gh = await githubClient()
      if (!gh) return !cancelled && setState({ status: 'no-token' })
      const pull = await gh.openPullForBranch({ owner, name }, head, headOwner ?? owner)
      if (cancelled) return
      if (pull) void navigate(prPath({ owner, name, number: pull.number }), { replace: true })
      else setState({ status: 'no-pull' })
    }
    run().catch((error: unknown) => !cancelled && setState({ status: 'error', message: errorMessage(error) }))
    return () => {
      cancelled = true
    }
  }, [owner, name, head, headOwner, navigate])

  const label = `${owner}/${name} ${compare.base ? `${compare.base}...` : ''}${headOwner ? `${headOwner}:` : ''}${head}`
  if (state.status === 'loading') return <p className="page muted">Looking for the pull request from {head}…</p>
  return (
    <ShareFrame>
      {state.status === 'no-token' && (
        <p>
          A compare link opens the pull request from its branch, which Code Ducky looks up on GitHub with your token.{' '}
          <Link to="/settings">Add a token in Settings</Link>, then share the link again.
        </p>
      )}
      {state.status === 'no-pull' && (
        <p>
          There is no open pull request from <strong>{head}</strong> in {owner}/{name}. Code Ducky reviews pull requests; open one from
          the compare page on GitHub, then share it here.
        </p>
      )}
      {state.status === 'error' && <p className="error">Could not look up {label}: {state.message}</p>}
      <p>
        <a href={compare.url} target="_blank" rel="noreferrer">
          Open the compare on GitHub
        </a>{' '}
        · <Link to="/inbox">Inbox</Link>
      </p>
    </ShareFrame>
  )
}

function Unrecognised({ shared }: { shared: string[] }) {
  return (
    <ShareFrame>
      <p>Code Ducky opens GitHub pull requests. Share a pull request link (github.com/owner/repo/pull/123) or a compare link, and it opens for review.</p>
      {shared.length > 0 ? (
        <>
          <p className="muted">This was shared, but it has neither:</p>
          <blockquote className="share-received">
            {shared.map((value, index) => (
              <p key={index}>{value}</p>
            ))}
          </blockquote>
        </>
      ) : (
        <p className="muted">Nothing was shared.</p>
      )}
      <p>
        <Link to="/inbox">Inbox</Link> · <Link to="/">Repos</Link>
      </p>
    </ShareFrame>
  )
}

function ShareFrame({ children }: { children: ReactNode }) {
  return (
    <section className="page narrow stack">
      <StatusBar mode="share" />
      <PageHeader icon={Share2} title="shared with code ducky" />
      {children}
    </section>
  )
}
