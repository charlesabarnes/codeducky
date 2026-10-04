import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

const mix = (color: string, percent: number) => `color-mix(in oklch, var(${color}) ${percent}%, transparent)`

/**
 * Every colour, font and size is one of the app's CSS variables, so the editor follows the palette,
 * light or dark, the density and the code font without being rebuilt.
 */
const chrome = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--fg)',
    backgroundColor: 'var(--bg)',
    fontSize: 'var(--code-size)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    lineHeight: 'var(--code-line)',
    fontVariantLigatures: 'none',
  },
  '.cm-content': { caretColor: 'var(--accent)', padding: 'var(--cell-y) 0' },
  '.cm-line': { padding: '0 var(--pad-x) 0 8px' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--accent)' },
  '.cm-selectionBackground': { backgroundColor: mix('--fg-2', 25) },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: mix('--accent', 30) },
  '.cm-content ::selection': { backgroundColor: mix('--accent', 30) },
  '.cm-activeLine': { backgroundColor: mix('--bg-3', 55) },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-2)',
    color: 'var(--fg-2)',
    borderRight: '1px solid var(--line)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 10px', minWidth: '4ch' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-3)', color: 'var(--fg)' },
  '.cm-specialChar': { color: 'var(--del-fg)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--bg-3)', outline: '1px solid var(--fg-2)' },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--del-bg)', color: 'var(--del-fg)' },
  '.cm-selectionMatch': { backgroundColor: mix('--sx-n', 18) },
  '.cm-searchMatch': { backgroundColor: mix('--mod-fg', 28), outline: `1px solid ${mix('--mod-fg', 70)}` },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: mix('--accent', 40), outline: '1px solid var(--accent)' },
  '.cm-panels': { backgroundColor: 'var(--bg-2)', color: 'var(--fg)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panel.cm-search': {
    padding: 'var(--pad-y) 32px var(--pad-y) var(--pad-x)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-size)',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': { margin: '2px 8px 2px 0' },
  '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--fg-2)', fontSize: 'inherit' },
  '.cm-panel.cm-search input[type=checkbox]': { margin: 0 },
  '.cm-panel.cm-search [name=close]': { top: 'var(--pad-y)', right: 'var(--pad-x)', color: 'var(--fg-2)', fontSize: '16px' },
  '.cm-textfield': {
    padding: '0 6px',
    border: '1px solid var(--line)',
    borderRadius: 0,
    backgroundColor: 'var(--bg)',
    color: 'var(--fg)',
    font: 'var(--text-size)/calc(var(--text-line) - 2px) var(--font-code)',
  },
  '.cm-textfield:focus': { outline: '1px solid var(--accent)', borderColor: 'var(--accent)' },
  '.cm-button': {
    padding: '0 6px',
    border: '1px solid var(--line)',
    borderRadius: 0,
    backgroundImage: 'none',
    backgroundColor: 'var(--bg)',
    color: 'var(--fg)',
    font: 'var(--text-size)/calc(var(--text-line) - 2px) var(--font-mono)',
    textTransform: 'lowercase',
    cursor: 'pointer',
  },
  '.cm-button:hover': { borderColor: 'var(--fg-2)', backgroundColor: 'var(--bg-3)' },
  '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--bg-3)' },
  '.cm-tooltip': { border: '1px solid var(--line)', backgroundColor: 'var(--bg-2)', color: 'var(--fg)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-3)', border: 'none', color: 'var(--fg-2)' },
})

/** The same mapping as the diff's Shiki theme (--sx-* in styles.css), so code reads alike in both. */
const syntax = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self], color: 'var(--sx-k)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.escape, t.docString], color: 'var(--sx-s)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName, t.link, t.url], color: 'var(--sx-n)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.name), t.standard(t.name), t.typeName, t.className, t.namespace, t.tagName, t.attributeName, t.labelName], color: 'var(--sx-c)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta, t.processingInstruction], color: 'var(--fg-2)' },
  { tag: [t.variableName, t.propertyName, t.punctuation, t.operator, t.bracket], color: 'var(--sx-f)' },
  { tag: t.heading, color: 'var(--sx-k)', fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, textDecoration: 'underline' },
  { tag: [t.inserted], color: 'var(--add-fg)' },
  { tag: [t.deleted, t.invalid], color: 'var(--del-fg)' },
  { tag: t.changed, color: 'var(--mod-fg)' },
])

export const redlineTheme = [chrome, syntaxHighlighting(syntax)]
