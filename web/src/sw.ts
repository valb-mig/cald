import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { kvSet } from './lib/db'
import { SHARE_KEY, SHARE_PATH, type Shared } from './lib/share'
import type { PushPayload } from './lib/types'

declare const self: ServiceWorkerGlobalScope

// Só o app shell vai para o cache; API e WebSocket sempre direto no PC. Versão nova assume na hora.
self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)
// O link fixo de um artefato (`/a/<id>/`) é uma página do próprio servidor, não uma tela do app.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//, /^\/ws/, /^\/a\//] }))

// ---- "Compartilhar" do Android (share_target no manifesto) ----

// O Android manda um POST com os arquivos; guarda no banco do app e abre a tela de escolher a conversa.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'POST' || new URL(event.request.url).pathname !== SHARE_PATH) return
  event.respondWith(
    (async () => {
      const form = await event.request.formData()
      const field = (name: string) => {
        const v = form.get(name)
        return typeof v === 'string' && v.trim() ? v : undefined
      }
      const shared: Shared = {
        title: field('title'),
        text: field('text'),
        url: field('url'),
        files: form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0),
        at: Date.now(),
      }
      await kvSet(SHARE_KEY, shared)
      return Response.redirect(SHARE_PATH, 303)
    })(),
  )
})

// ---- notificações (o PC manda pelo Web Push; ver server/src/notifier.ts) ----

// `renotify` e `timestamp` existem no Chrome, mas não nos tipos do TypeScript.
type ShowOptions = NotificationOptions & { renotify?: boolean; timestamp?: number }

self.addEventListener('push', (event) => {
  let payload: PushPayload
  try {
    payload = event.data?.json() as PushPayload
  } catch {
    return
  }
  if (payload?.title) event.waitUntil(show(payload))
})

async function show(p: PushPayload): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const visible = windows.filter((c) => c.visibilityState === 'visible')
  // A conversa já está na tela: o aviso só atrapalharia.
  if (visible.some((c) => new URL(c.url).pathname === p.url)) return
  const options: ShowOptions = {
    body: p.body,
    // Com o app na tela, o som é o dele (web/src/lib/sounds.ts): o aviso chega sem tocar de novo.
    silent: visible.length > 0,
    // Uma por conversa: a nova substitui a anterior e vibra de novo.
    tag: p.tag,
    renotify: true,
    icon: '/pwa-192.png',
    badge: '/badge-96.png',
    timestamp: p.ts,
    data: { url: p.url },
  }
  await self.registration.showNotification(p.title, options)
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data as { url?: string } | null)?.url ?? '/'
  event.waitUntil(openApp(url))
})

/** Traz o app para a frente na conversa do aviso; fechado, abre direto nela. */
async function openApp(url: string): Promise<void> {
  const [client] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  if (!client) {
    await self.clients.openWindow(url)
    return
  }
  await client.focus()
  client.postMessage({ type: 'navigate', url })
}
