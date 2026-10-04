import { StreamLanguage, type StreamParser } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

type Loader = () => Promise<Extension>

const legacy = (parser: StreamParser<unknown>) => StreamLanguage.define(parser)

/** Editor modes by the diff highlighter's language ids (see languageFor), each fetched the first time it is needed. */
const LOADERS: Record<string, Loader> = {
  typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  tsx: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
  jsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  jsonc: async () => (await import('@codemirror/lang-json')).json(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  scss: async () => (await import('@codemirror/lang-sass')).sass(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  vue: async () => (await import('@codemirror/lang-html')).html(),
  svelte: async () => (await import('@codemirror/lang-html')).html(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  php: async () => (await import('@codemirror/lang-php')).php(),
  c: async () => (await import('@codemirror/lang-cpp')).cpp(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  shellscript: async () => legacy((await import('@codemirror/legacy-modes/mode/shell')).shell),
  toml: async () => legacy((await import('@codemirror/legacy-modes/mode/toml')).toml),
  ruby: async () => legacy((await import('@codemirror/legacy-modes/mode/ruby')).ruby),
  swift: async () => legacy((await import('@codemirror/legacy-modes/mode/swift')).swift),
  kotlin: async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  csharp: async () => legacy((await import('@codemirror/legacy-modes/mode/clike')).csharp),
  docker: async () => legacy((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile),
}

/** The editor mode for a highlighter language id, or null for plain text. */
export async function loadLanguage(language: string | null): Promise<Extension | null> {
  const load = language ? LOADERS[language] : undefined
  return load ? load() : null
}
