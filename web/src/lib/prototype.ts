import { create } from 'zustand'
import { WIDE_QUERY } from './hooks'
import { useProjectPanel } from './project-panel'
import { openPanelTab } from './workbench'

/**
 * Uma página do Claude: o HTML que a ferramenta Artifact do Claude Code publica no claude.ai (ou qualquer
 * .html do projeto). O claude.ai não deixa a página dele ser embutida, então o app mostra o arquivo
 * local, servido pelo PC num iframe isolado (ver components/prototype/prototype-view.tsx), e liga de
 * volta para o artifact no claude.ai (`url`). `title`: a descrição que o Claude deu ao publicar.
 */
export type PrototypeRef = { machine: string; path: string; cwd?: string; url?: string; title?: string }

/** As extensões que abrem como página. */
export const isHtmlPath = (path: string) => /\.html?$/i.test(path)

/** O link do artifact no claude.ai, no que a ferramenta Artifact devolveu. */
export const ARTIFACT_URL = /https:\/\/(?:preview\.)?claude\.ai\/(?:code\/)?artifact\/[\w-]+/

/** Uma página que a ferramenta Artifact publicou: o arquivo local, a descrição (curta) e o link no claude.ai. */
export type PublishedPage = { path: string; title?: string; url?: string }

const text = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * A página de uma chamada da Artifact que publicou (sem `action`, ou `publish`) e deu certo; `null`
 * para o resto (ler, listar, falha, ainda rodando). O link vem do resultado, ou do `url` que ela atualizou.
 */
export function publishedPage(name: string, input: Record<string, unknown>, result?: { isError: boolean; text: string }): PublishedPage | null {
  if (name !== 'Artifact' || !result || result.isError) return null
  const path = text(input.file_path)
  if ((text(input.action) || 'publish') !== 'publish' || !path) return null
  const url = result.text.match(ARTIFACT_URL)?.[0] ?? text(input.url).match(ARTIFACT_URL)?.[0]
  const line = text(input.description).split('\n')[0]!.trim()
  const title = line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line
  return { path, title: title || undefined, url }
}

/**
 * `path` absoluto e sem `.` nem `..`: relativo, parte de `cwd`. É o que vai na aba, para a mesma página,
 * aberta pelo chat (relativa) e pela árvore de arquivos, não abrir duas.
 */
export function absolutePath(path: string, cwd?: string): string {
  const full = path.startsWith('/') || !cwd ? path : `${cwd.replace(/\/+$/, '')}/${path}`
  if (!full.startsWith('/')) return full
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** A página aberta em tela cheia no celular (ver PrototypeDialog); no PC ela é uma aba. */
export const usePrototypeDialog = create<{ open: PrototypeRef | null }>(() => ({ open: null }))
export const closePrototypeDialog = () => usePrototypeDialog.setState({ open: null })

/** Abre a página: no PC numa aba, como um arquivo; no celular, por cima de tudo, com o voltar. */
export function showPrototype(ref: PrototypeRef): void {
  const page = { ...ref, path: absolutePath(ref.path, ref.cwd) }
  if (!matchMedia(WIDE_QUERY).matches) return usePrototypeDialog.setState({ open: page })
  openPanelTab({ kind: 'prototype', ...page })
  // A folha do projeto (janela estreita) sai da frente da aba que acabou de abrir.
  useProjectPanel.setState({ sheet: false })
}
