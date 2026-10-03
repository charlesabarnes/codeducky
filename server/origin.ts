import type { Context } from 'hono'

/**
 * The origin clients see. Set SKELBERT_PUBLIC_URL when the proxy in front rewrites the host;
 * otherwise the forwarded protocol and host (gangway sets both) or the request URL are used.
 */
export function publicOrigin(c: Context, configured?: string): string {
  if (configured) return new URL(configured).origin
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(/:$/, '')
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host') || url.host
  return new URL(`${proto}://${host}`).origin
}

export const MCP_PATH = '/mcp'
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'

export const mcpResource = (origin: string) => `${origin}${MCP_PATH}`
export const resourceMetadataUrl = (origin: string) => `${origin}${PROTECTED_RESOURCE_PATH}${MCP_PATH}`
