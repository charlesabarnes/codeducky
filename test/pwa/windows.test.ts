import { describe, expect, it, vi } from 'vitest'
import { WindowBus, type WindowChannel, type WindowMessage } from '../../src/pwa/windows'
import { openFileWindow } from '../../src/features/window/windowSync'

/** BroadcastChannel semantics, synchronously: every other member of the hub gets each message, the sender does not. */
function hub() {
  const members: { listener: (event: MessageEvent) => void }[] = []
  const join = (): WindowChannel => {
    const member: { listener: (event: MessageEvent) => void } = { listener: () => undefined }
    members.push(member)
    return {
      postMessage: (message: WindowMessage) => {
        for (const other of members) if (other !== member) other.listener({ data: structuredClone(message) } as MessageEvent)
      },
      addEventListener: (_type, listener) => (member.listener = listener),
    }
  }
  return { open: (id: string) => new WindowBus(join(), id) }
}

describe('WindowBus', () => {
  it('tells other windows which file is dirty, and clears it when saved', () => {
    const { open } = hub()
    const main = open('main')
    const file = open('file')
    const changed = vi.fn()
    main.subscribe(changed)

    file.setDirty([{ sessionId: 's1', path: 'src/a.ts' }])
    expect(main.dirtyElsewhere('s1')).toBe('src/a.ts')
    expect(main.dirtyElsewhere('s2')).toBe('')
    expect(file.dirtyElsewhere('s1')).toBe('')
    expect(changed).toHaveBeenCalledTimes(1)

    file.setDirty([])
    expect(main.dirtyElsewhere('s1')).toBe('')
  })

  it('warns both ways when the same file is dirty in two windows', () => {
    const { open } = hub()
    const a = open('a')
    const b = open('b')
    a.setDirty([{ sessionId: 's', path: 'x.ts' }])
    b.setDirty([{ sessionId: 's', path: 'x.ts' }])
    expect(a.dirtyElsewhere('s')).toBe('x.ts')
    expect(b.dirtyElsewhere('s')).toBe('x.ts')
  })

  it('answers a new window with what is dirty, and forgets a window that closes', () => {
    const { open } = hub()
    const main = open('main')
    main.setDirty([{ sessionId: 's', path: 'b.ts' }])
    const late = open('late')
    expect(late.dirtyElsewhere('s')).toBe('')
    late.hello()
    expect(late.dirtyElsewhere('s')).toBe('b.ts')
    main.bye()
    expect(late.dirtyElsewhere('s')).toBe('')
  })

  it('passes a picked note to the other windows only', () => {
    const { open } = hub()
    const main = open('main')
    const file = open('file')
    const inFile = vi.fn()
    const inMain = vi.fn()
    file.onNoteFocus(inFile)
    const stop = main.onNoteFocus(inMain)
    main.focusNote({ sessionId: 's', path: 'a.ts', noteId: 'n1' })
    expect(inFile).toHaveBeenCalledWith({ sessionId: 's', path: 'a.ts', noteId: 'n1' })
    expect(inMain).not.toHaveBeenCalled()
    stop()
  })

  it('ignores messages that are not its own protocol', () => {
    let deliver: (event: MessageEvent) => void = () => undefined
    const bus = new WindowBus({ postMessage: () => undefined, addEventListener: (_type, listener) => (deliver = listener) }, 'me')
    deliver({ data: 'hello' } as MessageEvent)
    deliver({ data: { type: 'dirty' } } as MessageEvent)
    expect(bus.dirtyElsewhere('s')).toBe('')
  })
})

describe('openFileWindow', () => {
  it('opens the file window route under a name per file, so a second open reuses it', () => {
    const open = vi.fn(() => ({}) as Window)
    expect(openFileWindow('sess 1', 'src/a b.ts', open)).toBe(true)
    expect(open).toHaveBeenCalledWith('/sessions/sess%201/window?file=src%2Fa+b.ts', 'codeducky-file:sess 1:src/a b.ts')
    expect(openFileWindow('s', 'a.ts', () => null)).toBe(false)
  })
})
