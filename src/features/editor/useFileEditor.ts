import { useEffect, useRef, useState, type RefObject } from 'react'
import type { EditorController } from '../../editor/controller'
import { commitFile, type PrAccess } from '../../editor/githubFile'
import { saveLocalFile } from '../../editor/localFile'
import { errorMessage } from '../../github/errors'
import type { FileChange } from '../../git/types'
import { editAccess, loadEditableFile, reloadEditableFile, type EditableFile, type EditSource } from './editSource'

export type LoadState = { kind: 'loading' } | { kind: 'unavailable'; message: string } | { kind: 'ready'; file: EditableFile }

export type AccessState = { kind: 'checking' } | { kind: 'unknown' } | PrAccess

export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  /** A pull request save waits for its commit message. */
  | { kind: 'commit-message' }
  /** The folder is still read-only: the next step must come from a click, for the browser's prompt. */
  | { kind: 'needs-permission' }
  | { kind: 'conflict'; message: string; canOverwrite: boolean }
  | { kind: 'error'; message: string }

const IDLE: SaveStatus = { kind: 'idle' }
const short = (sha: string) => sha.slice(0, 7)

interface Options {
  source: EditSource
  change: FileChange
  controller: RefObject<EditorController | null>
  /** After a successful save, with a message to announce. */
  onSaved: (message: string) => void
}

/** Loads a session file for the editor and runs its saves: to disk for local sessions, as a commit for pull requests. */
export function useFileEditor({ source, change, controller, onSaved }: Options) {
  const path = change.path
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [access, setAccess] = useState<AccessState>(source.kind === 'github' ? { kind: 'checking' } : { kind: 'unknown' })
  const [status, setStatus] = useState<SaveStatus>(IDLE)
  const saved = useRef<EditableFile | null>(null)
  const [initial] = useState({ source, change })

  useEffect(() => {
    let cancelled = false
    loadEditableFile(initial.source, initial.change)
      .then((result) => {
        if (cancelled) return
        if (result.kind === 'ready') saved.current = result.file
        setLoad(result)
      })
      .catch((error: unknown) => !cancelled && setLoad({ kind: 'unavailable', message: `Could not read the file: ${errorMessage(error)}` }))
    editAccess(initial.source)
      .then((result) => !cancelled && result && setAccess(result))
      .catch(() => !cancelled && setAccess({ kind: 'unknown' }))
    return () => {
      cancelled = true
    }
  }, [initial])

  const busy = status.kind === 'saving'
  const blocked = access.kind === 'blocked' || access.kind === 'checking'

  const writeLocal = async (root: FileSystemDirectoryHandle, options: { force?: boolean; allowPrompt?: boolean }) => {
    const editor = controller.current
    const base = saved.current
    if (!editor || base?.base.kind !== 'local') return
    const snapshot = editor.snapshot()
    setStatus({ kind: 'saving' })
    try {
      const result = await saveLocalFile(root, path, snapshot.text, { format: base.format, expected: base.base.version, ...options })
      if (result.kind === 'saved') {
        saved.current = { text: snapshot.text, format: base.format, base: { kind: 'local', version: result.version } }
        editor.markSaved(snapshot.doc)
        setStatus(IDLE)
        onSaved(`Saved ${path}`)
      } else if (result.kind === 'needs-permission') {
        setStatus(result)
      } else if (result.kind === 'denied') {
        setStatus({ kind: 'error', message: 'Write access to the folder was not granted, so nothing was saved.' })
      } else {
        const message = result.deleted ? `${path} was deleted on disk since you opened it.` : `${path} changed on disk since you opened it.`
        setStatus({ kind: 'conflict', message, canOverwrite: true })
      }
    } catch (error) {
      setStatus({ kind: 'error', message: `Could not save: ${errorMessage(error)}` })
    }
  }

  const commit = async (message: string) => {
    const editor = controller.current
    const base = saved.current
    if (!editor || source.kind !== 'github' || access.kind !== 'ok' || base?.base.kind !== 'github') return
    const snapshot = editor.snapshot()
    setStatus({ kind: 'saving' })
    try {
      const result = await commitFile(source.gh, access.target, path, { text: snapshot.text, format: base.format, sha: base.base.sha, message })
      if (result.kind === 'committed') {
        saved.current = { text: snapshot.text, format: base.format, base: { kind: 'github', sha: result.blobSha } }
        editor.markSaved(snapshot.doc)
        setStatus(IDLE)
        onSaved(`Committed ${short(result.commitSha)} to ${access.target.branch}`)
      } else if (result.kind === 'conflict') {
        setStatus({ kind: 'conflict', message: result.message, canOverwrite: false })
      } else {
        setStatus({ kind: 'error', message: result.message })
      }
    } catch (error) {
      setStatus({ kind: 'error', message: `Could not commit: ${errorMessage(error)}` })
    }
  }

  const save = () => {
    if (busy || load.kind !== 'ready') return
    if (source.kind === 'local') void writeLocal(source.root, {})
    else if (!blocked) setStatus({ kind: 'commit-message' })
  }

  const reload = async () => {
    setStatus({ kind: 'saving' })
    try {
      const result = await reloadEditableFile(source, path)
      if (result.kind !== 'ready') return setStatus({ kind: 'error', message: result.message })
      saved.current = result.file
      controller.current?.replace(result.file.text)
      setStatus(IDLE)
    } catch (error) {
      setStatus({ kind: 'error', message: `Could not reload: ${errorMessage(error)}` })
    }
  }

  const revert = () => {
    if (saved.current) controller.current?.replace(saved.current.text)
  }

  return {
    load,
    access,
    status,
    busy,
    canSave: load.kind === 'ready' && !busy && !(source.kind === 'github' && blocked),
    save,
    commit: (message: string) => void commit(message),
    allowWrite: () => source.kind === 'local' && void writeLocal(source.root, { allowPrompt: true }),
    overwrite: () => source.kind === 'local' && void writeLocal(source.root, { force: true, allowPrompt: true }),
    reload: () => void reload(),
    revert,
    dismiss: () => setStatus(IDLE),
  }
}
