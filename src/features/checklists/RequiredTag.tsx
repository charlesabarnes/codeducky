import { Lock } from 'lucide-react'

export function RequiredTag() {
  return (
    <span className="badge warn" title="Unticked items block a push through the pre-push gate">
      <Lock size={11} aria-hidden />
      required
    </span>
  )
}
