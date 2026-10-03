import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'

export function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true })),
    [text],
  )
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
