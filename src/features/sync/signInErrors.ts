import type { AdminSignInResult } from '../../sync/controller'

export type SignInFragment = { handoff: string } | { error: string } | null

/** Reads `#handoff=…` or `#error=…` from the URL fragment the server's GitHub callback redirects to. */
export function parseSignInFragment(hash: string): SignInFragment {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const handoff = params.get('handoff')
  if (handoff) return { handoff }
  const error = params.get('error')
  return error ? { error } : null
}

const MESSAGES: Record<string, string> = {
  access_denied: 'You cancelled the GitHub sign-in.',
  invalid_state: 'The sign-in expired or was started in another browser. Try again.',
  signups_closed: 'This server is not taking new accounts.',
  account_disabled: 'This account is disabled. Ask the server admin.',
  github_error: 'GitHub could not complete the sign-in. Try again.',
  rate_limited: 'Too many sign-in attempts. Wait a few minutes and try again.',
  disabled: 'This account is disabled. Ask the server admin.',
  invalid: 'The sign-in link expired or was already used. Try again.',
  offline: 'Could not reach the server.',
  error: 'The server could not sign you in.',
  missing: 'This page only finishes a sign-in started from Settings.',
}

/** A message for a callback `#error=` code or a failed sign-in result. */
export function signInErrorMessage(code: string): string {
  return MESSAGES[code] ?? MESSAGES.error!
}

const ADMIN_MESSAGES: Partial<Record<AdminSignInResult, string>> = {
  invalid: 'Wrong passphrase.',
  throttled: 'Too many attempts. Wait a few minutes and try again.',
  unavailable: 'Admin sign-in is turned off on this server.',
}

export function adminSignInErrorMessage(result: AdminSignInResult): string {
  return ADMIN_MESSAGES[result] ?? signInErrorMessage(result)
}
