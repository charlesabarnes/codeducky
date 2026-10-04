import type { User } from '../../users/store'

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

/** The same palette as the PWA (src/styles.css), so the consent page feels like part of the app. */
const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--bg-subtle:#f6f8fa;--fg:#1f2328;--fg-muted:#59636e;--border:#d1d9e0;
--accent:#0969da;--accent-fg:#fff;--del-fg:#d1242f;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
font-size:14px;line-height:1.5;background:var(--bg);color:var(--fg)}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--bg-subtle:#151b23;--fg:#e6edf3;--fg-muted:#9198a1;
--border:#30363d;--accent:#4493f8;--accent-fg:#0d1117;--del-fg:#f85149}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1rem}
main{width:100%;max-width:26rem;background:var(--bg-subtle);border:1px solid var(--border);border-radius:8px;padding:1.5rem}
.brand{font-weight:600;color:var(--fg-muted);font-size:.85rem;letter-spacing:.02em;margin:0 0 1rem}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0 0 .75rem}.muted{color:var(--fg-muted)}
.uri{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;
background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.4rem .6rem;margin:0 0 1rem}
label{display:grid;gap:.25rem;margin:0 0 1rem;font-weight:500}
input{font:inherit;padding:.4rem .6rem;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:inherit}
.row{display:flex;gap:.5rem}button{font:inherit;padding:.35rem .85rem;border-radius:6px;border:1px solid transparent;cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-fg)}button.secondary{background:transparent;color:inherit;border-color:var(--border)}
.error{color:var(--del-fg)}a{color:var(--accent)}
.who{display:flex;align-items:center;gap:.5rem}.avatar{border-radius:50%;border:1px solid var(--border)}
`

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Code Ducky</title><style>${STYLE}</style></head><body><main><p class="brand">Code Ducky</p>${body}</main></body></html>`
}

export interface ConsentView {
  user: Pick<User, 'login' | 'avatarUrl'>
  clientName: string
  redirectUri: string
  /** The pending consent; the authorization request itself stays on the server. */
  flow: string
  ticket: string
}

const AVATAR_ORIGIN = 'https://avatars.githubusercontent.com'
const avatar = (url: string | null) =>
  url?.startsWith(`${AVATAR_ORIGIN}/`) ? `<img class="avatar" src="${escapeHtml(url)}" alt="" width="32" height="32">` : ''

export function consentPage({ user, clientName, redirectUri, flow, ticket }: ConsentView): string {
  return page(
    'Authorize',
    `<p class="who">${avatar(user.avatarUrl)}<span>Signed in to GitHub as <strong>@${escapeHtml(user.login)}</strong></span></p>
<p class="muted">Not you? <a href="https://github.com/logout" rel="noreferrer">Sign out of GitHub</a>, then start again from your MCP client.</p>
<h1>Allow <strong>${escapeHtml(clientName)}</strong> to read and change <em>your</em> Code Ducky review data?</h1>
<p class="muted">It will be able to read and change your review notes, sessions and checklists over MCP. You can revoke it in Settings.</p>
<p>After you approve, you are sent to:</p>
<p class="uri">${escapeHtml(redirectUri)}</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="flow" value="${escapeHtml(flow)}">
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
<div class="row"><button class="primary" type="submit" name="decision" value="approve" autofocus>Approve</button>
<button class="secondary" type="submit" name="decision" value="deny">Deny</button></div>
</form>`,
  )
}

export function errorPage(message: string): string {
  return page('Authorization error', `<h1>Cannot authorize</h1><p class="error">${escapeHtml(message)}</p>`)
}

/** Clickjacking and caching protection for every authorization page. */
export const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src ${AVATAR_ORIGIN}; frame-ancestors 'none'; base-uri 'none'`,
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}
