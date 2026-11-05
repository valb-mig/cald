import { PanelsTopLeft } from 'lucide-react'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from './api'
import { onChanged } from './changes'
import { WIDE_QUERY } from './hooks'
import { baseOf, HOME } from './machines'
import { useProjectPanel } from './project-panel'
import type { Artefato, ArtefatoList, ArtefatoVersao } from './types'
import { openPanelTab } from './workbench'

/**
 * Os artefatos de cada máquina: as páginas que o Claude publica pelo MCP do cald (`publicar_artefato`),
 * cada uma com versões congeladas, um link fixo na tailnet e, se você ligar, um link público. Carregados
 * uma vez por máquina e atualizados a cada `changed: artefatos`: o cartão no chat, a aba, a galeria e a
 * paleta leem daqui.
 */

/** O ícone de artefato, o mesmo em todo lugar (o do protótipo do claude.ai é o `AppWindow`). */
export const ArtefatoIcon = PanelsTopLeft

type State = {
  byMachine: Record<string, ArtefatoList | undefined>
  /** O que deu errado na última busca da máquina (servidor antigo, fora do ar). */
  errors: Record<string, string | undefined>
}

export const useArtefatos = create<State>(() => ({ byMachine: {}, errors: {} }))

const loading = new Map<string, Promise<ArtefatoList>>()

const failure = (err: unknown) => (isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err))
export const artefatoFailed = (err: unknown) => toast.error(failure(err))

/** Busca de novo (ou pela primeira vez) os artefatos da máquina. */
export function loadArtefatos(machine: string): Promise<ArtefatoList> {
  let request = loading.get(machine)
  if (!request) {
    request = api.artefatos(machine).then(
      (list) => {
        loading.delete(machine)
        useArtefatos.setState((s) => ({ byMachine: { ...s.byMachine, [machine]: list }, errors: { ...s.errors, [machine]: undefined } }))
        return list
      },
      (err: unknown) => {
        loading.delete(machine)
        useArtefatos.setState((s) => ({ errors: { ...s.errors, [machine]: failure(err) } }))
        throw err
      },
    )
    loading.set(machine, request)
  }
  return request
}

// O Claude publicou (ou outro aparelho mexeu): a máquina que já tem a lista busca de novo.
onChanged((machine, c) => {
  if (c.what === 'artefatos' && useArtefatos.getState().byMachine[machine]) loadArtefatos(machine).catch(() => {})
})

/** A lista da máquina, buscada na primeira vez que alguém pede. */
export function useArtefatoList(machine: string): ArtefatoList | undefined {
  const list = useArtefatos((s) => s.byMachine[machine])
  useEffect(() => {
    if (!list) loadArtefatos(machine).catch(() => {})
  }, [list, machine])
  return list
}

/** O artefato e onde ele está: na lista, na lixeira ou em lugar nenhum (com a lista já carregada). */
export function useArtefato(machine: string, id: string) {
  const list = useArtefatoList(machine)
  const error = useArtefatos((s) => s.errors[machine])
  return {
    artefato: list?.artefatos.find((a) => a.id === id),
    trashed: list?.lixeira.find((a) => a.id === id),
    loaded: Boolean(list),
    error,
  }
}

export const latestOf = (a: Artefato): ArtefatoVersao | undefined => a.versions.at(-1)

/** Põe na lista o artefato que voltou do PC (o público ligado, o restaurado), no lugar dele. */
function put(machine: string, a: Artefato): void {
  useArtefatos.setState((s) => {
    const list = s.byMachine[machine]
    if (!list) return s
    const known = list.artefatos.some((x) => x.id === a.id)
    const artefatos = known ? list.artefatos.map((x) => (x.id === a.id ? a : x)) : [...list.artefatos, a].sort((x, y) => y.updatedAt - x.updatedAt)
    return { byMachine: { ...s.byMachine, [machine]: { artefatos, lixeira: list.lixeira.filter((x) => x.id !== a.id) } } }
  })
}

/** Liga ou desliga o link público; ligar de novo, já ligado, publica a versão atual no mesmo link. */
export async function setArtefatoPublic(machine: string, id: string, on: boolean): Promise<boolean> {
  try {
    put(machine, await api.setArtefatoPublic(machine, id, on))
    return true
  } catch (err) {
    artefatoFailed(err)
    return false
  }
}

/** Manda para a lixeira (volta por 30 dias). */
export async function trashArtefato(machine: string, a: Artefato): Promise<boolean> {
  try {
    await api.deleteArtefato(machine, a.id)
    useArtefatos.setState((s) => {
      const list = s.byMachine[machine]
      if (!list) return s
      const lixo = { ...a, deletedAt: Date.now() }
      return { byMachine: { ...s.byMachine, [machine]: { artefatos: list.artefatos.filter((x) => x.id !== a.id), lixeira: [lixo, ...list.lixeira] } } }
    })
    loadArtefatos(machine).catch(() => {})
    return true
  } catch (err) {
    artefatoFailed(err)
    return false
  }
}

export async function restoreArtefato(machine: string, id: string): Promise<Artefato | null> {
  try {
    const a = await api.restoreArtefato(machine, id)
    put(machine, a)
    loadArtefatos(machine).catch(() => {})
    return a
  } catch (err) {
    artefatoFailed(err)
    return null
  }
}

/** Apaga de vez, da lixeira. */
export async function purgeArtefato(machine: string, id: string): Promise<void> {
  try {
    await api.purgeArtefato(machine, id)
    useArtefatos.setState((s) => {
      const list = s.byMachine[machine]
      return list ? { byMachine: { ...s.byMachine, [machine]: { ...list, lixeira: list.lixeira.filter((x) => x.id !== id) } } } : s
    })
  } catch (err) {
    artefatoFailed(err)
  }
}

// ---- links ----

/**
 * O link fixo, com a origem da máquina (a desta página, ou o endereço da outra no Tailscale): sem `n`, a
 * versão atual; com, aquela versão (`/a/<id>/v/<n>/`).
 */
export function artefatoLink(machine: string, link: string, n?: number): string {
  const path = link.endsWith('/') ? link : `${link}/`
  return `${baseOf(machine) || location.origin}${path}${n ? `v/${n}/` : ''}`
}

export function copyLink(url: string): void {
  // Sem HTTPS (o atalho em http), o navegador não dá a área de transferência.
  if (!navigator.clipboard) {
    toast.error('Este navegador não deixa copiar daqui.')
    return
  }
  navigator.clipboard.writeText(url).then(
    () => toast.success('Link copiado'),
    () => toast.error('Não deu para copiar.'),
  )
}

/** "12 KB", "1,4 MB": o tamanho de uma versão. */
export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`
}

/** "1 arquivo · 12 KB" */
export const versionSize = (v: ArtefatoVersao) => `${v.files === 1 ? '1 arquivo' : `${v.files} arquivos`} · ${fileSize(v.bytes)}`

// ---- o que a ferramenta publicou ----

/** A ferramenta do MCP do cald que publica (o nome do servidor pode vir com o prefixo do plugin). */
const PUBLISH_TOOL = /^mcp__[\w-]*cald[\w-]*__publicar_artefato$/
export const isPublishTool = (name: string) => PUBLISH_TOOL.test(name)

/** Uma publicação no chat: o artefato, a versão que ela criou, o arquivo de origem e o link fixo. */
export type Publicacao = { id: string; title: string; n: number; file: string; link?: string }

const text = (v: unknown) => (typeof v === 'string' ? v : '')

/** O JSON que a ferramenta devolveu, mesmo com texto em volta. */
function parse(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(raw.slice(start, end + 1)) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A publicação de uma chamada de `publicar_artefato` que deu certo; `null` para o resto (falha, rodando). */
export function publishedArtefato(name: string, input: Record<string, unknown>, result?: { isError: boolean; text: string }): Publicacao | null {
  if (!isPublishTool(name) || !result || result.isError) return null
  const out = parse(result.text)
  const id = text(out?.id)
  const n = Number(out?.versao)
  if (!out || !id || !Number.isInteger(n) || n < 1) return null
  const file = text(input.arquivo).split('/').pop() ?? ''
  return { id, title: text(out.titulo) || text(input.titulo) || file || 'Artefato', n, file, link: text(out.link) || undefined }
}

// ---- abrir ----

/** Um artefato para ver: `n` é a versão (sem ela, a atual); `title`, o nome antes de a lista chegar. */
export type ArtefatoRef = { machine: string; id: string; n?: number; title?: string }

/** O artefato aberto em tela cheia no celular (ver ArtefatoDialog); no PC ele é uma aba. */
export const useArtefatoDialog = create<{ open: ArtefatoRef | null }>(() => ({ open: null }))
export const closeArtefatoDialog = () => useArtefatoDialog.setState({ open: null })

/** Abre o artefato: no PC numa aba (e a galeria sai da frente); no celular, por cima de tudo, com o voltar. */
export function showArtefato(ref: ArtefatoRef): void {
  if (!matchMedia(WIDE_QUERY).matches) return useArtefatoDialog.setState({ open: ref })
  openPanelTab({ kind: 'artefato', ...ref })
  useProjectPanel.setState({ sheet: false })
  useArtefatosDialog.setState({ open: false })
}

/** A galeria: a máquina, o artefato escolhido e o projeto de onde ela foi aberta (para começar nele). */
export type GaleriaAt = { machine: string; id?: string; cwd?: string }

/** `opened` conta as aberturas: aberta de novo (por outro cartão, por exemplo), ela começa no que foi pedido. */
export const useArtefatosDialog = create<{ open: boolean; at: GaleriaAt; opened: number }>(() => ({ open: false, at: { machine: HOME }, opened: 0 }))

/** Abre a galeria; sem máquina, a do projeto em foco (ou esta). */
export function openArtefatos(at: Partial<GaleriaAt> = {}): void {
  const project = useProjectPanel.getState().project
  const machine = at.machine ?? project?.machine ?? HOME
  const cwd = at.cwd ?? (project && project.machine === machine ? project.cwd : undefined)
  useArtefatosDialog.setState((s) => ({ open: true, at: { machine, id: at.id, cwd }, opened: s.opened + 1 }))
}
