import { uuidv7 } from '../sync/ids'

/** A file with unsaved edits in some window's editor. */
export interface DirtyFile {
  sessionId: string
  path: string
}

export interface NoteFocusEvent {
  sessionId: string
  path: string
  noteId: string
}

/** What windows of the app tell each other. Notes and viewed state need none of it: Dexie's liveQuery covers them. */
export type WindowMessage =
  | { type: 'hello'; from: string }
  | { type: 'dirty'; from: string; files: DirtyFile[] }
  | { type: 'bye'; from: string }
  | ({ type: 'note-focus'; from: string } & NoteFocusEvent)

export interface WindowChannel {
  postMessage(message: WindowMessage): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

const isMessage = (data: unknown): data is WindowMessage =>
  typeof data === 'object' && data !== null && typeof (data as { type?: unknown }).type === 'string' && typeof (data as { from?: unknown }).from === 'string'

/**
 * Keeps the app's windows aware of each other over a BroadcastChannel: which files have unsaved edits elsewhere,
 * so two editors on one file warn, and which note was picked, so a file window can scroll to it. A new window says
 * hello and the others answer with their state; a closing one says bye.
 */
export class WindowBus {
  readonly id: string
  private readonly channel: WindowChannel
  private mine: DirtyFile[] = []
  private readonly others = new Map<string, DirtyFile[]>()
  private readonly listeners = new Set<() => void>()
  private readonly focusListeners = new Set<(event: NoteFocusEvent) => void>()

  constructor(channel: WindowChannel, id = uuidv7()) {
    this.channel = channel
    this.id = id
    channel.addEventListener('message', (event) => this.receive(event.data))
  }

  /** Announces this window; the others answer with their unsaved files. */
  hello(): void {
    this.post({ type: 'hello', from: this.id })
    if (this.mine.length) this.post({ type: 'dirty', from: this.id, files: this.mine })
  }

  bye(): void {
    this.post({ type: 'bye', from: this.id })
  }

  setDirty(files: DirtyFile[]): void {
    if (files.length === 0 && this.mine.length === 0) return
    this.mine = files
    this.post({ type: 'dirty', from: this.id, files })
  }

  /** Paths of the session with unsaved edits in other windows, sorted and joined by newlines (stable for React). */
  dirtyElsewhere(sessionId: string): string {
    const paths = new Set<string>()
    for (const files of this.others.values()) for (const file of files) if (file.sessionId === sessionId) paths.add(file.path)
    return [...paths].sort().join('\n')
  }

  focusNote(event: NoteFocusEvent): void {
    this.post({ type: 'note-focus', from: this.id, ...event })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onNoteFocus(listener: (event: NoteFocusEvent) => void): () => void {
    this.focusListeners.add(listener)
    return () => this.focusListeners.delete(listener)
  }

  private post(message: WindowMessage): void {
    this.channel.postMessage(message)
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  private receive(data: unknown): void {
    if (!isMessage(data) || data.from === this.id) return
    switch (data.type) {
      case 'hello':
        if (this.mine.length) this.post({ type: 'dirty', from: this.id, files: this.mine })
        return
      case 'dirty':
        if (data.files.length) this.others.set(data.from, data.files)
        else this.others.delete(data.from)
        return this.changed()
      case 'bye':
        if (this.others.delete(data.from)) this.changed()
        return
      case 'note-focus':
        for (const listener of this.focusListeners) listener({ sessionId: data.sessionId, path: data.path, noteId: data.noteId })
    }
  }
}

let shared: WindowBus | null | undefined

/** This window's bus; null where BroadcastChannel is missing. */
export function windowBus(): WindowBus | null {
  if (shared !== undefined) return shared
  if (typeof BroadcastChannel === 'undefined') return (shared = null)
  const bus = new WindowBus(new BroadcastChannel('codeducky-windows'))
  window.addEventListener('pagehide', () => bus.bye())
  window.addEventListener('pageshow', (event) => event.persisted && bus.hello())
  bus.hello()
  return (shared = bus)
}
