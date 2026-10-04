const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A random PKCE verifier: 32 bytes, base64url. */
export function createVerifier(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)))
}

/** The S256 challenge for a verifier. */
export async function challengeOf(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}
