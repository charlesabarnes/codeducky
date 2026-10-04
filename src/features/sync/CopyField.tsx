import { Check, Copy } from 'lucide-react'
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
      <div className="copy-row">
        <code className={block ? 'copy-value block' : 'copy-value'}>
          {!block && (
            <span className="prompt" aria-hidden="true">
              ${' '}
            </span>
          )}
          {value}
        </code>
        <button type="button" className="secondary" onClick={() => void copy()}>
          {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
    </div>
  )
}
