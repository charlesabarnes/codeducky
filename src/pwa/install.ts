const INSTALLED_MODES = ['standalone', 'window-controls-overlay']

/** Whether Code Ducky runs as an installed app rather than in a browser tab. */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true
  return INSTALLED_MODES.some((mode) => window.matchMedia?.(`(display-mode: ${mode})`).matches)
}
