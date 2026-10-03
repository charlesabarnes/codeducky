import { useState } from 'react'

/** A labelled value with a copy button; `block` keeps line breaks, for multi-line snippets. */
export function CopyField({ label, value, block }: { label: string; value: string; block?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="copy-field">
      <span className="copy-label">{label}</span>
      <div className="row">
        <code className={block ? 'mono copy-value block' : 'mono copy-value'}>{value}</code>
        <button type="button" className="secondary" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
