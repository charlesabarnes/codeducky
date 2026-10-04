import { ExternalLink, Link2 } from 'lucide-react'
import { useState } from 'react'
import { githubPrUrl, prPath, type PullRef } from '../../../shared/links'

const rubberduckPrUrl = (ref: PullRef) => `${location.origin}${prPath(ref)}`

/** "Copy Rubberduck link" and "Open on GitHub" for a pull request. */
export function PrLinks({ pull, compact }: { pull: PullRef; compact?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rubberduckPrUrl(pull))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copy the Rubberduck link', rubberduckPrUrl(pull))
    }
  }
  return (
    <span className="pr-links row" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="link" onClick={copy} title={rubberduckPrUrl(pull)} aria-live="polite">
        <Link2 size={12} aria-hidden />
        {copied ? 'copied' : compact ? 'copy link' : 'copy rubberduck link'}
      </button>
      <a href={githubPrUrl(pull)} target="_blank" rel="noreferrer" className="icon-link">
        {compact ? 'github' : 'open on github'}
        <ExternalLink size={11} aria-hidden />
      </a>
    </span>
  )
}
