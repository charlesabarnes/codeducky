import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { useEffect, useRef, useState } from 'react'
import type { EditorController } from './controller'
import { DirtyTracker } from './dirty'
import { detectIndent } from './indent'
import { loadLanguage } from './languages'
import { redlineTheme } from './theme'

export interface CodeEditorProps {
  text: string
  /** The diff highlighter's language id for the file, or null for plain text. */
  language: string | null
  label: string
  onReady: (controller: EditorController) => void
  onDirtyChange: (dirty: boolean) => void
  onSave: () => void
}

/** Density and code font change CSS variables only; the editor re-measures its lines when they do. */
const APPEARANCE_ATTRIBUTES = ['data-density', 'data-code-font']

function editing(text: string, label: string, save: () => void): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of(detectIndent(text)),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          save()
          return true
        },
      },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    EditorView.contentAttributes.of({ 'aria-label': label }),
    redlineTheme,
  ]
}

export default function CodeEditor({ text, language, label, onReady, onDirtyChange, onSave }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  // The editor is built once per file; later prop changes must not rebuild it and lose the edits.
  const [initial] = useState({ text, language, label })
  const callbacks = useRef({ onReady, onDirtyChange, onSave })
  useEffect(() => {
    callbacks.current = { onReady, onDirtyChange, onSave }
  })

  useEffect(() => {
    const languageSlot = new Compartment()
    const state = EditorState.create({
      doc: initial.text,
      extensions: [
        editing(initial.text, initial.label, () => callbacks.current.onSave()),
        languageSlot.of([]),
        EditorView.updateListener.of((update) => update.docChanged && tracker.update(update.state.doc)),
      ],
    })
    const tracker = new DirtyTracker(state.doc, (dirty) => callbacks.current.onDirtyChange(dirty))
    const view = new EditorView({ parent: host.current!, state })

    let cancelled = false
    loadLanguage(initial.language)
      .then((extension) => !cancelled && extension && view.dispatch({ effects: languageSlot.reconfigure(extension) }))
      .catch((error: unknown) => console.error('Could not load the editor language', error))

    const appearance = new MutationObserver(() => view.requestMeasure())
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: APPEARANCE_ATTRIBUTES })

    callbacks.current.onReady({
      snapshot: () => ({ doc: view.state.doc, text: view.state.doc.toString() }),
      markSaved: (doc) => tracker.markSaved(doc, view.state.doc),
      replace(next) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
        tracker.markSaved(view.state.doc, view.state.doc)
      },
      focus: () => view.focus(),
    })
    return () => {
      cancelled = true
      appearance.disconnect()
      view.destroy()
    }
  }, [initial])

  return <div ref={host} className="code-editor" data-own-keys />
}
