export async function hashBlob(content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${content.byteLength}\0`)
  const object = new Uint8Array(header.byteLength + content.byteLength)
  object.set(header)
  object.set(content, header.byteLength)
  const digest = await crypto.subtle.digest('SHA-1', object)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
