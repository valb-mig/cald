import { create } from 'zustand'
import { HOME, baseOf, useMachines } from './machines'
import { authHeader, baseOfUrl, clearTokens, setToken, tokenAt } from './pin-tokens'

/**
 * A tela de bloqueio do PIN (ver server/src/pin.ts). Cada máquina confere o PIN e devolve o token
 * dela; você digita uma vez e o app destrava todas (o PIN precisa ser o mesmo em cada uma, definido
 * com `cald -pin`). Enquanto destravado, o PIN fica só em memória, para destravar sozinho uma máquina
 * que aparecer depois ou cujo token caiu. Travar (na mão, pelo tempo ou ao ir para o fundo) apaga os
 * tokens daqui e nos servidores.
 */

type Lock = {
  /** `checking`: perguntando à máquina desta página se há PIN. */
  status: 'checking' | 'locked' | 'open'
  /** Alguma máquina pede PIN (para mostrar os ajustes de travamento). */
  enabled: boolean
  /** Dígitos do PIN, para as bolinhas e para conferir sem apertar Enter. */
  length: number
  /** Já destravou uma vez nesta aba: o app está montado por baixo da tela de bloqueio. */
  started: boolean
  /** Conta cada destravada, para as conexões reabrirem com o token novo (ver store.ts). */
  round: number
}

export const useLock = create<Lock>(() => ({ status: 'checking', enabled: false, length: 4, started: false, round: 0 }))

let pin: string | null = null
// Máquinas a não tentar de novo com o PIN em memória até a próxima destravada: as sem PIN e as que
// recusaram (PIN diferente). Insistir gastaria as tentativas delas até a espera.
const skip = new Set<string>()

function open(): void {
  useLock.setState((s) => ({ status: 'open', started: true, round: s.round + 1 }))
}

/** Na carga do app: há PIN? O token guardado nesta aba ainda vale? */
export async function checkLock(): Promise<void> {
  try {
    const res = await fetch('/api/pin', { headers: authHeader('/api/pin') })
    // Servidor anterior ao PIN.
    if (res.status === 404) return open()
    const body = (await res.json()) as { enabled: boolean; length?: number; unlocked?: boolean }
    useLock.setState({ enabled: body.enabled, length: body.length ?? 4 })
    if (!body.enabled || body.unlocked) return open()
    clearTokens()
    useLock.setState({ status: 'locked' })
  } catch {
    // A máquina desta página fora do ar: abre com a lista guardada; as outras, se pedirem PIN, travam
    // o app pela resposta delas (ver `pinRejected`).
    open()
  }
}

export type UnlockResult =
  | { ok: true }
  | { ok: false; error: 'wrong'; attemptsLeft?: number }
  | { ok: false; error: 'blocked'; retryAfter: number }
  | { ok: false; error: 'offline' }

type Answer = { token?: string; disabled?: boolean; error?: string; attemptsLeft?: number; retryAfter?: number }

async function unlockAt(base: string, value: string): Promise<Answer> {
  try {
    const res = await fetch(`${base}/api/pin/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: value }),
    })
    const body = (await res.json().catch(() => ({}))) as Answer
    if (res.ok && body.token) setToken(base, body.token)
    // Sem PIN, PIN errado ou esperando: fora do ar não conta, ela volta a tentar quando responder.
    else if ([409, 403, 429].includes(res.status)) skip.add(base)
    return res.status === 409 ? { disabled: true } : body
  } catch {
    return { error: 'offline' }
  }
}

const bases = () => useMachines.getState().machines.map((m) => baseOf(m.id))

/** Confere o PIN em todas as máquinas de uma vez; destrava se alguma aceitar. */
export async function unlock(value: string): Promise<UnlockResult> {
  skip.clear()
  const answers = await Promise.all(bases().map((base) => unlockAt(base, value)))
  if (answers.some((a) => a.token)) {
    pin = value
    open()
    return { ok: true }
  }
  const blocked = answers.filter((a) => a.error === 'pin_blocked').map((a) => a.retryAfter ?? 30)
  if (blocked.length) return { ok: false, error: 'blocked', retryAfter: Math.max(...blocked) }
  const wrong = answers.filter((a) => a.error === 'pin_wrong')
  if (wrong.length) return { ok: false, error: 'wrong', attemptsLeft: Math.min(...wrong.map((a) => a.attemptsLeft ?? 0)) }
  // Nenhuma pede PIN (foi desligado enquanto a tela estava aberta).
  if (answers.every((a) => a.disabled)) {
    open()
    return { ok: true }
  }
  return { ok: false, error: 'offline' }
}

/** Trava o app: os tokens deixam de valer aqui e nos servidores, e o PIN sai da memória. */
export function lockNow(): void {
  pin = null
  skip.clear()
  for (const [base, token] of Object.entries(clearTokens())) {
    void fetch(`${base}/api/pin/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
      // Vai mesmo com a página indo para o fundo ou fechando.
      keepalive: true,
    }).catch(() => {})
  }
  useLock.setState({ status: 'locked', enabled: true })
}

const retrying = new Map<string, Promise<boolean>>()

/**
 * Uma máquina recusou o token (`pin_required`). Com o PIN em memória, tenta destravar só ela de novo e
 * diz se deu (para repetir o pedido). Sem PIN em memória, ou se a máquina desta página recusar o PIN
 * (trocado no PC), o app trava. Outra máquina com PIN diferente fica só sem conexão.
 */
export function pinRejected(url: string): Promise<boolean> {
  const base = baseOfUrl(url)
  setToken(base, undefined)
  if (!pin) {
    if (useLock.getState().status === 'open') lockNow()
    return Promise.resolve(false)
  }
  if (skip.has(base)) return Promise.resolve(false)
  let pending = retrying.get(base)
  if (!pending) {
    pending = unlockAt(base, pin).then((a) => {
      if (!a.token && base === HOME && useLock.getState().status === 'open') lockNow()
      return Boolean(a.token)
    })
    pending.finally(() => retrying.delete(base))
    retrying.set(base, pending)
  }
  return pending
}

/** Máquina que apareceu na lista com o app destravado: destrava ela também, com o PIN em memória. */
function unlockNewMachines(): void {
  if (!pin) return
  for (const base of bases()) if (!tokenAt(base) && !skip.has(base) && !retrying.has(base)) void pinRejected(base || '/')
}

// ---- travar sozinho ----

const PREFS_KEY = 'cald:autolock'

/** Travar sozinho: depois de `minutes` sem tocar no app, ou com ele tanto tempo no fundo; `0` = ao ir para o fundo. */
export type AutoLock = { on: boolean; minutes: number }

export const AUTOLOCK_MINUTES = [0, 1, 5, 15, 30]

function loadPrefs(): AutoLock {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<AutoLock> | null
    return {
      on: saved?.on ?? true,
      minutes: AUTOLOCK_MINUTES.includes(saved?.minutes ?? -1) ? saved!.minutes! : 5,
    }
  } catch {
    return { on: true, minutes: 5 }
  }
}

export const useAutoLock = create<AutoLock>(loadPrefs)

export function setAutoLock(patch: Partial<AutoLock>): void {
  useAutoLock.setState(patch)
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(useAutoLock.getState()))
  } catch {
    // localStorage indisponível (modo privado): segue só em memória.
  }
}

function lockIfOpen(): void {
  const { status, enabled } = useLock.getState()
  if (enabled && status === 'open') lockNow()
}

let started = false

/** Liga o travamento por tempo e o destravamento das máquinas novas; uma vez só, na carga do app. */
export function startLock(): void {
  if (started) return
  started = true
  useMachines.subscribe(unlockNewMachines)

  let last = Date.now()
  const touch = () => (last = Date.now())
  for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    addEventListener(event, touch, { capture: true, passive: true })
  }

  let hiddenAt = 0
  document.addEventListener('visibilitychange', () => {
    const { on, minutes } = useAutoLock.getState()
    if (document.hidden) {
      hiddenAt = Date.now()
      // Imediato: trava já, para a miniatura da troca de apps sair com a tela de bloqueio.
      if (on && minutes === 0) lockIfOpen()
      return
    }
    // No fundo, os timers quase param: a conta é feita na volta.
    if (on && minutes > 0 && hiddenAt && Date.now() - hiddenAt >= minutes * 60_000) lockIfOpen()
    touch()
  })

  setInterval(() => {
    const { on, minutes } = useAutoLock.getState()
    if (on && minutes > 0 && !document.hidden && Date.now() - last >= minutes * 60_000) lockIfOpen()
  }, 10_000)
}
