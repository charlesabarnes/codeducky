import { useState } from 'react'
import { githubPrUrl, prPath, type PullRef } from '../../../shared/links'

const skelbertPrUrl = (ref: PullRef) => `${location.origin}${prPath(ref)}`

/** "Copy Skelbert link" and "Open on GitHub" for a pull request. */
export function PrLinks({ pull, compact }: { pull: PullRef; compact?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(skelbertPrUrl(pull))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copy the Skelbert link', skelbertPrUrl(pull))
    }
  }
  return (
    <span className="pr-links row" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="link" onClick={copy} title={skelbertPrUrl(pull)} aria-live="polite">
        {copied ? 'Copied' : compact ? 'Copy link' : 'Copy Skelbert link'}
      </button>
      <a href={githubPrUrl(pull)} target="_blank" rel="noreferrer">
        {compact ? 'GitHub' : 'Open on GitHub'}
      </a>
    </span>
  )
}
