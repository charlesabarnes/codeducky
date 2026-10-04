export const WCO_CLASS = 'wco'

interface WcoDeps {
  overlay: WindowControlsOverlay | undefined
  root: { classList: Pick<DOMTokenList, 'toggle'> }
}

/**
 * With `display_override: window-controls-overlay` the installed app can draw into the title bar. The
 * header moves there (see .wco in pwa.css) only while the overlay is on: the user can switch it off, and
 * browser tabs and plain standalone windows have none. Returns a function that stops following it.
 */
export function startWindowControls({ overlay, root }: WcoDeps = { overlay: navigator.windowControlsOverlay, root: document.documentElement }) {
  if (!overlay) return () => undefined
  const apply = () => root.classList.toggle(WCO_CLASS, overlay.visible)
  apply()
  overlay.addEventListener('geometrychange', apply)
  return () => {
    overlay.removeEventListener('geometrychange', apply)
    root.classList.toggle(WCO_CLASS, false)
  }
}
