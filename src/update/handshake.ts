import { CLIENT_HEADER, type ClientOutdatedBody } from '../../shared/clientVersion'
import { updates } from './updates'

export const CLIENT_BUILD = __CODEDUCKY_BUILD__

/** Sent on every request to the Code Ducky server so it can refuse builds older than its API. */
export const clientHeaders = (): Record<string, string> => ({ [CLIENT_HEADER]: CLIENT_BUILD })

const isOutdatedBody = (body: unknown): body is ClientOutdatedBody =>
  typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'client_outdated'

/** Starts the update when the server answered 426; returns whether it did. */
export function reportIfOutdated(status: number, body: unknown, report = updates): boolean {
  if (status !== 426) return false
  report.clientOutdated(isOutdatedBody(body) && typeof body.minimum === 'string' ? body.minimum : '')
  return true
}
