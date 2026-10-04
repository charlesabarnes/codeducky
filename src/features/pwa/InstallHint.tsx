import { Download } from 'lucide-react'
import { useInstallPrompt } from '../../pwa/installPrompt'
import './pwa.css'

/** A quiet header button while the browser offers to install the app; gone once it is installed. */
export function InstallHint() {
  const { installed, available, prompt } = useInstallPrompt()
  if (installed || !available) return null
  return (
    <button type="button" className="keys-hint install-hint" title="Install Code Ducky as an app" onClick={() => void prompt()}>
      <Download size={14} aria-hidden />
      install
    </button>
  )
}
