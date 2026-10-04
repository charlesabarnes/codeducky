import type { HighlighterCore, LanguageRegistration, ThemedToken } from 'shiki/core'

export type LineTokens = ThemedToken[][]

/** Token colours are CSS variables (--shiki-token-*, mapped in styles.css), so they follow the app theme. */
const THEME = 'rubberduck'
const MAX_HIGHLIGHT_BYTES = 256 * 1024

type LanguageLoader = () => Promise<{ default: LanguageRegistration[] }>

const LANGUAGES: Record<string, LanguageLoader> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  html: () => import('@shikijs/langs/html'),
  markdown: () => import('@shikijs/langs/markdown'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  python: () => import('@shikijs/langs/python'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  java: () => import('@shikijs/langs/java'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  sql: () => import('@shikijs/langs/sql'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  graphql: () => import('@shikijs/langs/graphql'),
  vue: () => import('@shikijs/langs/vue'),
  svelte: () => import('@shikijs/langs/svelte'),
  xml: () => import('@shikijs/langs/xml'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  ruby: () => import('@shikijs/langs/ruby'),
  php: () => import('@shikijs/langs/php'),
  swift: () => import('@shikijs/langs/swift'),
  docker: () => import('@shikijs/langs/docker'),
}

const EXTENSIONS: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'jsonc', json5: 'jsonc',
  css: 'css', scss: 'scss', html: 'html', htm: 'html',
  md: 'markdown', mdx: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  sql: 'sql', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  graphql: 'graphql', gql: 'graphql', graphqls: 'graphql', vue: 'vue', svelte: 'svelte',
  xml: 'xml', svg: 'xml', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift',
}

export function languageFor(path: string): string | null {
  const file = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (file === 'dockerfile' || file.endsWith('.dockerfile')) return 'docker'
  const ext = file.includes('.') ? file.slice(file.lastIndexOf('.') + 1) : ''
  return EXTENSIONS[ext] ?? null
}

let highlighter: Promise<HighlighterCore> | null = null

function loadHighlighter(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(
    ([{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [createCssVariablesTheme({ name: THEME, variablePrefix: '--shiki-' })],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      }),
  )
  return highlighter
}

export async function highlightLines(text: string, path: string): Promise<LineTokens | null> {
  const lang = languageFor(path)
  const loader = lang ? LANGUAGES[lang] : undefined
  if (!lang || !loader || text.length > MAX_HIGHLIGHT_BYTES) return null
  const core = await loadHighlighter()
  if (!core.getLoadedLanguages().includes(lang)) await core.loadLanguage(loader())
  return core.codeToTokensBase(text, { lang, theme: THEME })
}
