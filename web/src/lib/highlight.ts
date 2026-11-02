import { useEffect, useState } from 'react'
import type { HighlighterCore, ThemedToken } from 'shiki/core'
import { useDarkMode } from './hooks'

/**
 * Cores de sintaxe como no VSCode: o Shiki, com as gramáticas do próprio VSCode e os temas Dark+ e
 * Light+. Tudo vem sob demanda: o Shiki, a gramática de cada linguagem e o tema só baixam quando um
 * arquivo dela é aberto, e ficam fora do cache offline do app (ver vite.config.ts). Sem rede, ou com
 * um arquivo grande demais, ele aparece sem cores, como antes.
 */

type Module = Promise<{ default: unknown }>

// Uma importação por linguagem, escrita por extenso: é o que diz ao build quais gramáticas existem.
const LANGS: Record<string, () => Module> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  astro: () => import('shiki/langs/astro.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  prisma: () => import('shiki/langs/prisma.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  dotenv: () => import('shiki/langs/dotenv.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  make: () => import('shiki/langs/make.mjs'),
}

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'jsonc',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  dart: 'dart',
  lua: 'lua',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  prisma: 'prisma',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  ini: 'ini',
  service: 'ini',
}

/** A linguagem do arquivo pelo nome; `null` se não é uma que o app colore. */
export function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (name === 'Dockerfile' || name.endsWith('.Dockerfile')) return 'dockerfile'
  if (name === 'Makefile') return 'make'
  if (name === '.env' || name.startsWith('.env.')) return 'dotenv'
  const dot = name.lastIndexOf('.')
  return dot > 0 ? (BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null) : null
}

let core: Promise<HighlighterCore> | null = null

function highlighter(): Promise<HighlighterCore> {
  core ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(([shiki, engine]) =>
    // O motor de regex em JavaScript dispensa o WebAssembly do Oniguruma, bem mais pesado.
    shiki.createHighlighterCore({ themes: [], langs: [], engine: engine.createJavaScriptRegexEngine() }),
  )
  // Sem rede agora: da próxima vez tenta de novo.
  core.catch(() => (core = null))
  return core
}

const THEMES = {
  'dark-plus': () => import('shiki/themes/dark-plus.mjs'),
  'light-plus': () => import('shiki/themes/light-plus.mjs'),
}

/** O texto em linhas de tokens com cor, no tema do app agora. */
async function tokenize(code: string, lang: string, dark: boolean): Promise<ThemedToken[][]> {
  const hl = await highlighter()
  const theme = dark ? 'dark-plus' : 'light-plus'
  if (!hl.getLoadedThemes().includes(theme)) await hl.loadTheme((await THEMES[theme]()).default as never)
  if (!hl.getLoadedLanguages().includes(lang)) await hl.loadLanguage((await LANGS[lang]!()).default as never)
  return hl.codeToTokensBase(code, { lang, theme })
}

// Acima disso colorir trava a tela por tempo demais (no celular, principalmente): fica o texto puro.
const MAX_CHARS = 300_000
const MAX_LINES = 5_000

/**
 * Os tokens de cada linha de `code`, para o arquivo em `path`. `null` enquanto carrega, para
 * linguagem desconhecida, texto grande demais ou sem rede: quem usa mostra o texto puro.
 */
export function useTokens(code: string | null, path: string): ThemedToken[][] | null {
  const dark = useDarkMode()
  const lang = languageOf(path)
  const [done, setDone] = useState<{ code: string; lang: string; dark: boolean; lines: ThemedToken[][] } | null>(null)

  useEffect(() => {
    if (code === null || !lang || code.length > MAX_CHARS || code.split('\n', MAX_LINES + 1).length > MAX_LINES) return
    let alive = true
    tokenize(code, lang, dark).then(
      (lines) => alive && setDone({ code, lang, dark, lines }),
      () => {},
    )
    return () => {
      alive = false
    }
  }, [code, lang, dark])

  return done && done.code === code && done.lang === lang && done.dark === dark ? done.lines : null
}

/** Cor e estilo de um token, como o tema manda (itálico em comentários, por exemplo). */
export function tokenStyle(token: ThemedToken): React.CSSProperties {
  const style = token.fontStyle ?? 0
  return {
    color: token.color,
    fontStyle: style & 1 ? 'italic' : undefined,
    fontWeight: style & 2 ? 600 : undefined,
    textDecoration: style & 4 ? 'underline' : style & 8 ? 'line-through' : undefined,
  }
}
