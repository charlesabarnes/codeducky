import { db } from '../../db/db'
import { headRepoRef, prEditAccess, readBranchFile, type PrAccess } from '../../editor/githubFile'
import { readLocalFile, type DiskVersion } from '../../editor/localFile'
import { decodeText, type TextFormat } from '../../editor/textFormat'
import { cachedBlobLoader } from '../../github/blobCache'
import type { GitHubClient } from '../../github/client'
import type { PrSnapshot } from '../../github/prDiff'
import { DEFAULT_MAX_BYTES, isBinary } from '../../git/sides'
import type { FileChange } from '../../git/types'

/** Where the editor reads a session's file and saves it: the local working tree, or the pull request's head branch. */
export type EditSource = { kind: 'local'; root: FileSystemDirectoryHandle } | { kind: 'github'; gh: GitHubClient; snapshot: PrSnapshot }

/** What a save replaces: the file on disk as read, or the head branch's blob. */
export type SavedBase = { kind: 'local'; version: DiskVersion } | { kind: 'github'; sha: string }

export interface EditableFile {
  text: string
  format: TextFormat
  base: SavedBase
}

export type FileLoad = { kind: 'ready'; file: EditableFile } | { kind: 'unavailable'; message: string }

const UNEDITABLE = {
  binary: 'Binary files cannot be edited here.',
  tooLarge: 'This file is too large to edit here.',
  missing: 'This file is not in the working tree.',
}

async function loadLocal(root: FileSystemDirectoryHandle, path: string): Promise<FileLoad> {
  const read = await readLocalFile(root, path)
  if (read.kind !== 'text') return { kind: 'unavailable', message: read.kind === 'too-large' ? UNEDITABLE.tooLarge : UNEDITABLE[read.kind] }
  const { text, format, version } = read.file
  return { kind: 'ready', file: { text, format, base: { kind: 'local', version } } }
}

/** Reads the file as it is now: from disk, or the head blob the session shows. */
export async function loadEditableFile(source: EditSource, change: FileChange): Promise<FileLoad> {
  if (source.kind === 'local') return loadLocal(source.root, change.path)
  if (!change.newOid) return { kind: 'unavailable', message: UNEDITABLE.missing }
  const bytes = await cachedBlobLoader(db, source.gh, source.snapshot.ref)(change.newOid)
  if (isBinary(bytes)) return { kind: 'unavailable', message: UNEDITABLE.binary }
  if (bytes.byteLength > DEFAULT_MAX_BYTES) return { kind: 'unavailable', message: UNEDITABLE.tooLarge }
  return { kind: 'ready', file: { ...decodeText(bytes), base: { kind: 'github', sha: change.newOid } } }
}

/** Reads the file again after a conflict: what is on disk, or on the head branch now. */
export async function reloadEditableFile(source: EditSource, path: string): Promise<FileLoad> {
  if (source.kind === 'local') return loadLocal(source.root, path)
  const target = headRepoRef(source.snapshot.pull)
  if (!target) return { kind: 'unavailable', message: UNEDITABLE.missing }
  const branch = await readBranchFile(source.gh, { repo: target, branch: source.snapshot.pull.headRef }, path)
  return { kind: 'ready', file: { text: branch.text, format: branch.format, base: { kind: 'github', sha: branch.sha } } }
}

export function editAccess(source: EditSource): Promise<PrAccess | null> {
  return source.kind === 'github' ? prEditAccess(source.gh, source.snapshot.ref, source.snapshot.pull) : Promise.resolve(null)
}
