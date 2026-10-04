export type FileKind = 'markdown' | 'json'

const TYPES: Record<FileKind, FilePickerAcceptType> = {
  markdown: { description: 'Markdown', accept: { 'text/markdown': ['.md'] } },
  json: { description: 'JSON', accept: { 'application/json': ['.json'] } },
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

export async function saveTextFile(suggestedName: string, text: string, kind: FileKind): Promise<boolean> {
  let handle: FileSystemFileHandle
  try {
    handle = await window.showSaveFilePicker({ id: 'rubberduck-export', suggestedName, types: [TYPES[kind]] })
  } catch (error) {
    if (isAbort(error)) return false
    throw error
  }
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
  return true
}

export async function openTextFile(kinds: FileKind[]): Promise<{ name: string; text: string } | null> {
  let handles: FileSystemFileHandle[]
  try {
    handles = await window.showOpenFilePicker({ id: 'rubberduck-import', types: kinds.map((kind) => TYPES[kind]) })
  } catch (error) {
    if (isAbort(error)) return null
    throw error
  }
  const file = await handles[0]!.getFile()
  return { name: file.name, text: await file.text() }
}
