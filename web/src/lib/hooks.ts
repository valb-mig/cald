import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { api } from './api'
import type { GitStatus } from './types'

type External<T> = { subscribe: (onChange: () => void) => () => void; get: () => T }

// Uma inscrição por consulta, estável entre renders: criada no render, o React se reinscreveria a
// cada um deles.
const mediaQueries = new Map<string, External<boolean>>()

function mediaQuery(query: string): External<boolean> {
  let entry = mediaQueries.get(query)
  if (!entry) {
    const list = matchMedia(query)
    entry = {
      subscribe: (onChange) => {
        list.addEventListener('change', onChange)
        return () => list.removeEventListener('change', onChange)
      },
      get: () => list.matches,
    }
    mediaQueries.set(query, entry)
  }
  return entry
}

/** Se a media query vale agora, acompanhando mudanças (girar o celular, redimensionar a janela). */
export function useMediaQuery(query: string): boolean {
  const { subscribe, get } = mediaQuery(query)
  return useSyncExternalStore(subscribe, get)
}

/**
 * Layout de PC (a alça e a lista de conversas ao lado): a partir de 1024 px, ou já de 768 px com mouse
 * — uma janela de PC na metade da tela não é um celular. Tablet em pé, no toque, segue com as abas
 * embaixo. A variante `wide:` do CSS (index.css) tem a mesma consulta; mudando uma, mude a outra.
 */
export const WIDE_QUERY = '(min-width: 64rem), (min-width: 48rem) and (pointer: fine)'
export const useWide = () => useMediaQuery(WIDE_QUERY)

/** Se o app está no tema escuro agora: a classe que o next-themes põe no `<html>` é a fonte da verdade. */
export function useDarkMode(): boolean {
  return useSyncExternalStore(subscribeTheme, isDark)
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

const isDark = () => document.documentElement.classList.contains('dark')

/** Largura de um elemento, acompanhando a tela (girar o celular, abrir outra conversa ao lado). */
export function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/** Largura da janela, acompanhando o redimensionamento. */
export function useWindowWidth(): number {
  return useSyncExternalStore(subscribeResize, windowWidth)
}

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

const windowWidth = () => window.innerWidth

const homeRequests = new Map<string, Promise<string>>()

/** Pasta pessoal na máquina (uma consulta por máquina por carregamento do app). */
export function useHome(machine: string): string | undefined {
  const [home, setHome] = useState<string>()
  useEffect(() => {
    let request = homeRequests.get(machine)
    if (!request) homeRequests.set(machine, (request = api.health(machine).then((h) => h.home)))
    request.then(setHome, () => homeRequests.delete(machine))
  }, [machine])
  return home
}

/**
 * Git de cada projeto aberto, por máquina e pasta. Um lugar só para o selo no cabeçalho do chat e a
 * barra do projeto: um commit pela barra já atualiza o selo, e os dois juntos fazem uma consulta só.
 */
const useGitCache = create<Record<string, GitStatus | null>>(() => ({}))
const gitRequests = new Map<string, Promise<void>>()
const gitKey = (machine: string, cwd: string) => `${machine}\n${cwd}`

/** Relê o git do projeto (pedidos ao mesmo tempo viram um só). */
export function reloadGit(machine: string, cwd: string): Promise<void> {
  const key = gitKey(machine, cwd)
  let request = gitRequests.get(key)
  if (!request) {
    request = api
      .git(machine, cwd)
      .then(
        (s) => useGitCache.setState({ [key]: s }),
        () => useGitCache.setState({ [key]: null }),
      )
      .finally(() => gitRequests.delete(key))
    gitRequests.set(key, request)
  }
  return request
}

/** Avisa quando o git do projeto foi relido com outro resultado (um commit pela barra, o fim de um turno). */
export function subscribeGit(machine: string, cwd: string, onChange: () => void): () => void {
  const key = gitKey(machine, cwd)
  return useGitCache.subscribe((s, prev) => {
    if (s[key] !== prev[key]) onChange()
  })
}

/** Estado do git do projeto; relido quando `refresh` muda (ex.: a cada turno concluído). */
export function useGitStatus(
  machine: string,
  cwd: string | undefined,
  refresh: unknown,
): { status: GitStatus | null; loading: boolean; reload: () => void } {
  // `undefined`: a primeira resposta ainda não veio; `null`: o projeto não usa git.
  const entry = useGitCache((s) => (cwd ? s[gitKey(machine, cwd)] : null))
  useEffect(() => {
    if (cwd) void reloadGit(machine, cwd)
  }, [machine, cwd, refresh])
  return {
    status: entry ?? null,
    loading: entry === undefined,
    reload: () => {
      if (cwd) void reloadGit(machine, cwd)
    },
  }
}

const LONG_PRESS_MS = 500
// Dedo que andou mais que isso está rolando a lista, não segurando.
const MOVE_TOLERANCE = 10

/**
 * Abre um menu com o botão direito (PC) ou segurando o dedo (celular). O toque longo é feito aqui, e
 * não pelo do navegador: no iPhone ele não vira `contextmenu`, e no Android o menu do próprio Chrome
 * para links apareceria. Depois de um toque longo, o toque que segue não abre a conversa.
 */
export function usePressMenu(open: (x: number, y: number) => void) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const touch = useRef(false)
  // O toque longo já abriu o menu: o `contextmenu` do Android e o clique ao soltar ficam de fora.
  const opened = useRef(false)
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }
  return {
    onPointerDown: (e: React.PointerEvent) => {
      cancel()
      opened.current = false
      touch.current = e.pointerType !== 'mouse'
      if (!touch.current) return
      const { clientX: x, clientY: y } = e
      const timer = setTimeout(() => {
        press.current = null
        opened.current = true
        navigator.vibrate?.(10)
        open(x, y)
      }, LONG_PRESS_MS)
      press.current = { timer, x, y }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const p = press.current
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE) cancel()
    },
    onPointerUp: cancel,
    // A lista começou a rolar.
    onPointerCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      cancel()
      if (opened.current) return
      if (touch.current) opened.current = true
      // Tecla de menu do teclado: sem ponteiro, abre embaixo do item.
      if (e.clientX === 0 && e.clientY === 0) {
        const r = e.currentTarget.getBoundingClientRect()
        open(r.left + 16, r.bottom)
      } else {
        open(e.clientX, e.clientY)
      }
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!opened.current) return
      opened.current = false
      e.preventDefault()
      e.stopPropagation()
    },
  }
}
