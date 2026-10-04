import { GitCommitHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { defaultCommitMessage, type PrEditTarget } from '../../editor/githubFile'

interface CommitDialogProps {
  path: string
  target: PrEditTarget
  onCommit: (message: string) => void
  onClose: () => void
}

/** Asks for the message of the commit a pull request save makes. */
export function CommitDialog({ path, target, onCommit, onClose }: CommitDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [message, setMessage] = useState(() => defaultCommitMessage(path))
  const committed = useRef(false)

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const commit = () => {
    if (!message.trim()) return
    committed.current = true
    onCommit(message.trim())
    dialog.current?.close()
  }

  return (
    <dialog
      ref={dialog}
      className="modal commit-dialog"
      aria-labelledby="commit-title"
      onClose={() => !committed.current && onClose()}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault()
          commit()
        }}
      >
        <header className="modal-bar">
          <GitCommitHorizontal size={14} aria-hidden />
          <h2 id="commit-title">
            commit to {target.branch} <span className="muted">{`${target.repo.owner}/${target.repo.name}`}</span>
          </h2>
          <span className="spacer" />
          <button type="button" className="link" onClick={() => dialog.current?.close()}>
            <span className="key">esc</span> close
          </button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span>commit message</span>
            <input autoFocus type="text" value={message} onChange={(event) => setMessage(event.target.value)} spellCheck={false} />
          </label>
        </div>
        <footer className="modal-foot">
          <p>
            Commits <strong>{path}</strong> straight to the pull request branch.
          </p>
          <button type="button" className="secondary" onClick={() => dialog.current?.close()}>
            cancel
          </button>
          <button type="submit" disabled={!message.trim()}>
            <GitCommitHorizontal size={13} aria-hidden />
            commit
          </button>
        </footer>
      </form>
    </dialog>
  )
}
