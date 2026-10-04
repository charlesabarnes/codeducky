import { describe, expect, it } from 'vitest'
import { startWindowControls, WCO_CLASS } from '../../src/pwa/windowControls'

function fakeOverlay(visible: boolean) {
  const overlay = Object.assign(new EventTarget(), { visible })
  return overlay
}

function fakeRoot() {
  const classes = new Set<string>()
  return {
    classes,
    classList: {
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !classes.has(name)
        if (on) classes.add(name)
        else classes.delete(name)
        return on
      },
    },
  }
}

describe('window controls overlay', () => {
  it('marks the page while the overlay is visible', () => {
    const root = fakeRoot()
    startWindowControls({ overlay: fakeOverlay(true), root })
    expect(root.classes.has(WCO_CLASS)).toBe(true)
  })

  it('follows the user switching the overlay off and on', () => {
    const root = fakeRoot()
    const overlay = fakeOverlay(true)
    startWindowControls({ overlay, root })
    overlay.visible = false
    overlay.dispatchEvent(new Event('geometrychange'))
    expect(root.classes.has(WCO_CLASS)).toBe(false)
    overlay.visible = true
    overlay.dispatchEvent(new Event('geometrychange'))
    expect(root.classes.has(WCO_CLASS)).toBe(true)
  })

  it('leaves a standalone window without the overlay, and a browser tab without the API, alone', () => {
    const standalone = fakeRoot()
    startWindowControls({ overlay: fakeOverlay(false), root: standalone })
    expect(standalone.classes.size).toBe(0)

    const tab = fakeRoot()
    startWindowControls({ overlay: undefined, root: tab })
    expect(tab.classes.size).toBe(0)
  })

  it('stops following and drops the class', () => {
    const root = fakeRoot()
    const overlay = fakeOverlay(true)
    const stop = startWindowControls({ overlay, root })
    stop()
    expect(root.classes.has(WCO_CLASS)).toBe(false)
    overlay.dispatchEvent(new Event('geometrychange'))
    expect(root.classes.has(WCO_CLASS)).toBe(false)
  })
})
