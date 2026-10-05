import 'fake-indexeddb/auto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EditorPane } from '../../src/features/editor/EditorPane'
import { KeysContext } from '../../src/keys/context'
import { ShortcutDispatcher } from '../../src/keys/dispatcher'

const root = { kind: 'directory', name: 'repo' } as unknown as FileSystemDirectoryHandle
const keys = { dispatcher: new ShortcutDispatcher(), announce: () => undefined, openHelp: () => undefined }

function render(dirtyElsewhere: boolean) {
  const pane = createElement(EditorPane, {
    change: { path: 'src/a.ts', status: 'modified', oldOid: 'o', newOid: 'n' },
    source: { kind: 'local', root },
    hidden: false,
    dirty: true,
    dirtyElsewhere,
    onDirtyChange: () => undefined,
    onSaved: () => undefined,
    onShowDiff: () => undefined,
  })
  return renderToStaticMarkup(createElement(KeysContext.Provider, { value: keys }, pane))
}

describe('the file editor with the same file in another window', () => {
  it('warns when another window has unsaved edits to the file', () => {
    const html = render(true)
    expect(html).toContain('src/a.ts has unsaved edits in another Code Ducky window')
    expect(html).toContain('whichever window saves second is told the file changed on disk')
  })

  it('says nothing otherwise', () => {
    expect(render(false)).not.toContain('another Code Ducky window')
  })
})
