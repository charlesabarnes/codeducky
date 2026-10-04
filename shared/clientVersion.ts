/** The PWA sends its build id in this header on every request to the server; MCP clients, the plugin and the gate scripts do not. */
export const CLIENT_HEADER = 'X-CodeDucky-Client'

/** A build id is the UTC build time as YYYYMMDDHHMMSS, so later builds compare greater. */
const BUILD_ID = /^\d{14}$/

export const isBuildId = (value: string) => BUILD_ID.test(value)

export const buildIdAt = (date: Date) => date.toISOString().replace(/\D/g, '').slice(0, 14)

export const isOlderBuild = (build: string, minimum: string) => !isBuildId(build) || build < minimum

export interface ClientOutdatedBody {
  error: 'client_outdated'
  minimum: string
}
