/** Paths the Bun server answers itself; everything else is the PWA (its routes include /pr/… and /owner/name/pull/…). */
export const SERVER_PREFIXES = ['/api', '/mcp', '/oauth', '/.well-known', '/gate'] as const

export const isServerPath = (path: string) => SERVER_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))

/** Navigations the service worker must leave to the network instead of answering with index.html. */
export const NAVIGATE_DENYLIST: RegExp[] = [/^\/api\//, /^\/mcp/, /^\/oauth/, /^\/\.well-known\//, /^\/gate\//]
