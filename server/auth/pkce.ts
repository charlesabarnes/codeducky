import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** RFC 7636 S256: base64url(sha256(verifier)). */
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

export const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/
export const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/

export const randomSecret = () => randomBytes(32).toString('base64url')

/** Whether the verifier hashes to the challenge, compared in constant time. */
export function verifierMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !VERIFIER.test(verifier)) return false
  const given = Buffer.from(pkceChallenge(verifier))
  const expected = Buffer.from(challenge)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
