import { api } from './api'
import type { PushPrefs } from './types'

export type PushStatus = 'unsupported' | 'denied' | 'off' | 'on'

// Chave de antes da troca para cald, mantida para não perder as preferências do aparelho.
const PREFS_KEY = 'claude-remote:push-prefs'
const DEFAULT_PREFS: PushPrefs = { done: true, pc: true }

export function loadPrefs(): PushPrefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<PushPrefs>) }
  } catch {
    return DEFAULT_PREFS
  }
}

/** Service worker ativo; `null` sem ele (navegador sem suporte ou `pnpm dev:web`). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return null
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000))
  return Promise.race([navigator.serviceWorker.ready, timeout])
}

export async function pushStatus(): Promise<PushStatus> {
  const reg = await registration()
  if (!reg) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission !== 'granted') return 'off'
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off'
}

/** Pede a permissão, inscreve este aparelho e o registra no PC. */
export async function enablePush(): Promise<PushStatus> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off'
  await register(loadPrefs())
  return 'on'
}

export async function disablePush(): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription()
  if (!sub) return
  await api.pushUnsubscribe(sub.endpoint)
  await sub.unsubscribe()
}

export async function savePrefs(prefs: PushPrefs): Promise<void> {
  await register(prefs)
}

export async function testPush(): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription()
  if (!sub) throw new Error('Notificações desativadas neste aparelho.')
  await api.pushTest(sub.endpoint)
}

/**
 * Ao abrir o app, reafirma a inscrição no PC: o navegador pode tê-la trocado, ou o PC
 * pode ter gerado chaves novas (estado apagado).
 */
export async function syncPush(): Promise<void> {
  if ((await pushStatus()) === 'on') await register(loadPrefs())
}

/** Some com os avisos de uma conversa quando ela é aberta. */
export async function clearNotifications(sessionId: string): Promise<void> {
  const reg = await navigator.serviceWorker?.getRegistration()
  for (const n of (await reg?.getNotifications({ tag: sessionId })) ?? []) n.close()
}

async function register(prefs: PushPrefs): Promise<void> {
  const reg = await registration()
  if (!reg) throw new Error('Este navegador não recebe notificações.')
  const { publicKey } = await api.pushKey()
  const key = fromBase64Url(publicKey)
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await api.pushSubscribe(sub.toJSON(), prefs)
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function sameKey(current: ArrayBuffer | null, key: Uint8Array): boolean {
  if (!current || current.byteLength !== key.length) return false
  const bytes = new Uint8Array(current)
  return bytes.every((b, i) => b === key[i])
}
