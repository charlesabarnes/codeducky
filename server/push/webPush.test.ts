import { describe, expect, it } from 'bun:test'
import { buildPushRequest, createVapidSigner, encryptPayload, fromBase64Url, generateVapidKeys, toBase64Url, validAuthSecret, validPublicKey } from './webPush'
import { decryptPush, receiverKeys } from './testing'

/** RFC 8291 Appendix A, whitespace removed. */
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
}

async function rfcSenderKeys(): Promise<CryptoKeyPair> {
  const raw = fromBase64Url(RFC.asPublic)
  const jwk = { kty: 'EC', crv: 'P-256', x: toBase64Url(raw.subarray(1, 33)), y: toBase64Url(raw.subarray(33)), ext: true }
  return {
    publicKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
    privateKey: await crypto.subtle.importKey('jwk', { ...jwk, d: RFC.asPrivate }, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
  }
}

const decodeJwtPart = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>

describe('web push encryption', () => {
  it('matches the RFC 8291 example byte for byte', async () => {
    const body = await encryptPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, fromBase64Url(RFC.plaintext), {
      salt: fromBase64Url(RFC.salt),
      senderKeys: await rfcSenderKeys(),
    })
    expect(toBase64Url(body.subarray(0, 86))).toBe(RFC.header)
    expect(toBase64Url(body.subarray(86))).toBe(RFC.ciphertext)
  })

  it('round-trips with a fresh salt and sender key each time', async () => {
    const receiver = await receiverKeys()
    const first = await encryptPayload(receiver.target, new TextEncoder().encode('{"title":"hi"}'))
    const second = await encryptPayload(receiver.target, new TextEncoder().encode('{"title":"hi"}'))
    expect(toBase64Url(first)).not.toBe(toBase64Url(second))
    expect(await decryptPush(receiver, first)).toBe('{"title":"hi"}')
  })

  it('refuses a payload past one 4096-byte record', async () => {
    const receiver = await receiverKeys()
    await expect(encryptPayload(receiver.target, new Uint8Array(4000))).rejects.toThrow('too large')
  })

  it('validates subscription keys', async () => {
    const { target } = await receiverKeys()
    expect(validPublicKey(target.p256dh)).toBe(true)
    expect(validPublicKey(RFC.auth)).toBe(false)
    expect(validPublicKey('not base64!')).toBe(false)
    expect(validAuthSecret(target.auth)).toBe(true)
    expect(validAuthSecret(target.p256dh)).toBe(false)
  })
})

describe('vapid', () => {
  it('generates P-256 key pairs', async () => {
    const keys = await generateVapidKeys()
    expect(fromBase64Url(keys.publicKey)).toHaveLength(65)
    expect(fromBase64Url(keys.privateKey)).toHaveLength(32)
    expect(validPublicKey(keys.publicKey)).toBe(true)
  })

  it('signs an ES256 JWT for the push service origin and reuses it', async () => {
    const keys = await generateVapidKeys()
    let now = Date.UTC(2026, 9, 4)
    const signer = createVapidSigner({ ...keys, subject: 'mailto:ops@example.com' }, () => now)
    const header = await signer('https://fcm.googleapis.com/fcm/send/abc')
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header)!
    expect(match[2]).toBe(keys.publicKey)
    const [head, claims, signature] = match[1]!.split('.') as [string, string, string]
    expect(decodeJwtPart(head)).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(decodeJwtPart(claims)).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:ops@example.com' })
    const verifier = await crypto.subtle.importKey('raw', fromBase64Url(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, fromBase64Url(signature), new TextEncoder().encode(`${head}.${claims}`))
    expect(valid).toBe(true)
    expect(await signer('https://fcm.googleapis.com/fcm/send/other')).toBe(header)
    now += 11 * 3600_000
    expect(await signer('https://fcm.googleapis.com/fcm/send/abc')).not.toBe(header)
  })

  it('builds the delivery request', async () => {
    const keys = await generateVapidKeys()
    const receiver = await receiverKeys('https://updates.push.services.mozilla.com/wpush/v2/xyz')
    const request = await buildPushRequest(receiver.target, '{"title":"t"}', createVapidSigner({ ...keys, subject: 'https://ducky.example' }), 3600)
    expect(request.endpoint).toBe(receiver.target.endpoint)
    expect(request.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '3600', Urgency: 'normal' })
    expect(request.headers.Authorization).toStartWith('vapid t=')
    expect(await decryptPush(receiver, request.body)).toBe('{"title":"t"}')
  })
})
