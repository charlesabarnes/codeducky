import type { MiddlewareHandler } from 'hono'
import { CLIENT_HEADER, isOlderBuild, type ClientOutdatedBody } from '../shared/clientVersion'

/**
 * The oldest PWA build the API still serves. Raise it when the API changes in a way older clients
 * cannot handle: set it to a UTC time (YYYYMMDDHHMMSS) after the last build that needs refusing,
 * normally the time of the commit making the change, since every build made from that commit is later.
 */
export const MIN_CLIENT_BUILD = '20261004215556'

/** Refuses PWA builds older than `minimum` with 426; requests without the header (MCP, plugin, gate) pass. */
export function requireClientBuild(minimum = MIN_CLIENT_BUILD): MiddlewareHandler {
  return async (c, next) => {
    const build = c.req.header(CLIENT_HEADER)
    if (build !== undefined && isOlderBuild(build, minimum)) {
      return c.json({ error: 'client_outdated', minimum } satisfies ClientOutdatedBody, 426)
    }
    await next()
  }
}
