/** The same parser as plugin/src/sse.ts; the plugin is packaged on its own, so it keeps a copy. */
export interface SseEvent {
  event: string
  data: string
}

/** Parses a text/event-stream body into events. Comments and unknown fields are ignored. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
        if (data.length > 0 || event !== 'message') yield { event, data: data.join('\n') }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
