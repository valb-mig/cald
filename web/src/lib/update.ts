import { toast } from 'sonner'

/**
 * Versão nova do app. O service worker novo assume sozinho (skipWaiting + clientsClaim), mas a tela
 * aberta segue com o código antigo até recarregar: avisa, com um botão para atualizar. E, ao voltar
 * para o app, procura versão nova, porque o Android mantém o app vivo nos recentes sem recarregar.
 */
export function watchUpdates() {
  const sw = navigator.serviceWorker
  if (!sw) return
  // A primeira instalação também troca o controlador; só avisa se a tela já era de uma versão anterior.
  const hadController = Boolean(sw.controller)
  sw.addEventListener('controllerchange', () => {
    if (!hadController) return
    toast('Versão nova do app', {
      id: 'app-update',
      duration: Infinity,
      action: { label: 'Atualizar', onClick: () => location.reload() },
    })
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void sw.getRegistration().then((reg) => reg?.update())
  })
}

// O app novo para o qual esta aba já recarregou uma vez: se não adiantou, não recarrega de novo.
const RELOADED = 'cr:reloaded-for'

/** O script de entrada de um index.html: muda a cada build (o nome tem o hash). */
const entryOf = (doc: Document) => doc.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src') ?? null

/** O script de entrada do app que o servidor serve agora; `null` sem resposta. */
async function serverEntry(): Promise<string | null> {
  try {
    // Com um parâmetro no endereço, o pedido passa reto pelo service worker, que daria o index.html do cache.
    const res = await fetch(`/index.html?build=${Date.now()}`, { cache: 'no-store' })
    return res.ok ? entryOf(new DOMParser().parseFromString(await res.text(), 'text/html')) : null
  } catch {
    return null
  }
}

/** Marca que esta aba recarrega para o app `next`; `false` se já recarregou para ele e não adiantou. */
function markReload(next: string): boolean {
  try {
    if (sessionStorage.getItem(RELOADED) === next) return false
    sessionStorage.setItem(RELOADED, next)
    return true
  } catch {
    // Sem sessionStorage não há como saber se já tentou, e recarregar em ciclo é pior que o erro.
    return false
  }
}

/** O service worker do app novo no lugar do antigo: sem ele, recarregar abriria o index.html antigo do cache. */
async function updateServiceWorker(): Promise<void> {
  const sw = navigator.serviceWorker
  const reg = await sw?.getRegistration().catch(() => undefined)
  if (!sw || !reg) return
  await reg.update().catch(() => {})
  // O novo instala e assume sozinho (skipWaiting + clientsClaim, ver sw.ts): espera ele assumir.
  if (!reg.installing && !reg.waiting) return
  await new Promise<void>((resolve) => {
    sw.addEventListener('controllerchange', () => resolve(), { once: true })
    setTimeout(resolve, 10_000)
  })
}

/**
 * Um pedaço do app que baixa só quando é usado (o editor do PC, ver `assets/hl/` no vite.config.ts)
 * não carregou. O comum é o servidor ter sido atualizado com esta tela aberta: o build novo apagou os
 * arquivos do anterior, e o servidor responde com o index.html no lugar. No app do PC isso é o normal,
 * e não a exceção: a janela fica aberta por dias (fechar só esconde na bandeja). Com outro app no
 * servidor, recarrega nele, uma vez; sem (a rede caiu, ou recarregar não adiantou), segue o erro, e
 * quem chamou mostra o que dá sem esse pedaço.
 */
export async function reloadIfStale(err: unknown): Promise<never> {
  const mine = entryOf(document)
  const next = await serverEntry()
  if (!mine || !next || mine === next || !markReload(next)) throw err
  toast.loading('Atualizando o app', { id: 'app-update' })
  await updateServiceWorker()
  location.reload()
  // Até a página sair, quem esperava (o Suspense do editor) segue esperando.
  return new Promise<never>(() => {})
}
