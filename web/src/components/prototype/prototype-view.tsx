import { AppWindow, ArrowLeft, ExternalLink, FileX, RotateCw, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ClaudeMark } from '@/components/claude-mark'
import { splitPath } from '@/components/project/status'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, errorMessage, isOutdatedServer, OUTDATED_SERVER, prototypeViewUrl } from '@/lib/api'
import { shortPath } from '@/lib/format'
import { useWide } from '@/lib/hooks'
import { closePrototypeDialog, usePrototypeDialog, type PrototypeRef } from '@/lib/prototype'
import type { PrototypeOpen } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useGlass } from '@/lib/wallpaper'

/**
 * O que a página pode no iframe. Nunca `allow-same-origin`: escrita pelo Claude, ela roda com origem
 * opaca e não alcança a API do cald nem o que o app guarda. O PC manda a mesma CSP (ver server/src/prototypes.ts).
 */
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads'
/** De quanto em quanto tempo a aba à vista pergunta se o Claude mexeu na página. */
const POLL_MS = 2000

/**
 * Arrastando uma aba do app: o iframe sai do caminho do mouse, senão engole o arrasto, e soltar sobre a
 * página não levaria a aba para o grupo dela.
 */
function useDragging(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const start = () => setOn(true)
    const end = () => setOn(false)
    window.addEventListener('dragstart', start)
    window.addEventListener('dragend', end)
    window.addEventListener('drop', end)
    return () => {
      window.removeEventListener('dragstart', start)
      window.removeEventListener('dragend', end)
      window.removeEventListener('drop', end)
    }
  }, [])
  return on
}

/** No lugar da página: o arquivo que sumiu, ou o que o PC recusou, e o tentar de novo. */
function Problem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  // O `not_found` puro é o do servidor que ainda não tem a rota; a página que sumiu tem código próprio.
  const gone = error instanceof ApiError && error.code === 'prototype_not_found'
  return (
    <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      {gone ? <FileX className="size-8 text-muted-foreground/60" /> : <TriangleAlert className="size-8 text-muted-foreground/60" />}
      <p className="max-w-xs text-sm text-muted-foreground">
        {gone ? 'A página não está mais no PC.' : isOutdatedServer(error) ? OUTDATED_SERVER : errorMessage(error)}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Tentar de novo
      </Button>
    </div>
  )
}

type Props = PrototypeRef & {
  /** À vista (a aba ativa do grupo, ou a tela cheia aberta): só então ela confere se a página mudou. */
  active: boolean
  /** No celular, em tela cheia: com o voltar. */
  dialog?: boolean
  /** Um toque dentro da página: ela não chega ao app (é do iframe), então o grupo dela é avisado assim. */
  onInteract?: () => void
}

/**
 * Uma página do Claude num mini-navegador: a barra (recarregar, o endereço, o artifact no claude.ai e
 * abrir numa aba do navegador) e a página num iframe isolado, servida pelo PC. Com ela à vista, o Claude
 * mexeu no HTML (ou no CSS e nos scripts ao lado dele), ela recarrega sozinha.
 */
export function PrototypeView({ machine, path, cwd, url, title, active, dialog = false, onInteract }: Props) {
  const [page, setPage] = useState<PrototypeOpen | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  // Recarregar à mão: entra na URL, para o iframe pedir a página de novo mesmo sem ela ter mudado.
  const [reloads, setReloads] = useState(0)
  const [loaded, setLoaded] = useState<string | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const dragging = useDragging()
  const glass = useGlass() && !dialog

  const open = useCallback(() => api.openPrototype(machine, path, cwd), [machine, path, cwd])

  useEffect(() => {
    let alive = true
    open().then(
      (p) => {
        if (!alive) return
        setPage(p)
        setError(null)
      },
      (err) => {
        if (!alive) return
        setPage(null)
        setError(err)
      },
    )
    return () => {
      alive = false
    }
  }, [open])

  // À vista, com o app na frente: a cada 2 s, a versão da página. Mudou, o iframe recarrega; o PC esqueceu
  // o id (reiniciou), pede outro; o arquivo sumiu, vira o aviso. Sem rede, tenta na próxima volta.
  useEffect(() => {
    if (!active || !page) return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const { mtime } = await api.prototypeInfo(machine, page.id)
        if (!stop && mtime !== page.mtime) setPage({ ...page, mtime })
      } catch (err) {
        if (stop || !(err instanceof ApiError) || err.status !== 404) return
        try {
          const next = await open()
          if (!stop) setPage(next)
        } catch (gone) {
          if (stop) return
          setPage(null)
          setError(gone)
        }
      }
    }
    const loop = async () => {
      await check()
      if (!stop) timer = setTimeout(loop, POLL_MS)
    }
    timer = setTimeout(loop, POLL_MS)
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [active, page, machine, open])

  // O clique na página leva o foco para o iframe, e a janela do app perde o dela: é o sinal de que se mexe nela.
  useEffect(() => {
    if (!onInteract) return
    const onBlur = () =>
      setTimeout(() => {
        if (frame.current && document.activeElement === frame.current) onInteract()
      })
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [onInteract])

  // Pede o id de novo (pode ter expirado) e recarrega a página, mesmo sem ela ter mudado.
  const reload = () => {
    setBusy(true)
    open()
      .then(
        (p) => {
          setPage(p)
          setError(null)
          setReloads((n) => n + 1)
        },
        (err) => {
          setPage(null)
          setError(err)
        },
      )
      .finally(() => setBusy(false))
  }

  const view = page && prototypeViewUrl(machine, page.id, page.entry)
  // A versão vai na URL: o iframe novo (ver o `key`) não reaproveita a página velha do cache.
  const src = page && view && `${view}?v=${Math.round(page.mtime)}${reloads ? `.${reloads}` : ''}`
  const spinning = busy || Boolean(src && loaded !== src)
  const { name, dir } = splitPath(shortPath(path))
  const Title = dialog ? DialogTitle : 'h2'

  return (
    <>
      <header
        className={cn(
          'flex shrink-0 items-center gap-1 border-b px-2 pb-1.5',
          dialog ? 'pt-[max(0.375rem,env(safe-area-inset-top))]' : 'pt-1.5',
          glass && 'relative z-10 bg-background/70 backdrop-blur-md',
        )}
      >
        {dialog && (
          <Button variant="ghost" size="icon" onClick={closePrototypeDialog} aria-label="Voltar">
            <ArrowLeft />
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={reload} disabled={busy} aria-label="Recarregar" title="Recarregar">
          <RotateCw className={cn(spinning && 'animate-spin')} />
        </Button>
        {/* O endereço, só para ler: a pasta apagada e o arquivo, como a barra de um navegador. */}
        <div title={title ? `${title}\n${shortPath(path)}` : shortPath(path)} className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full bg-foreground/[0.05] px-3">
          <AppWindow className="size-3.5 shrink-0 text-muted-foreground" />
          <Title className="min-w-0 truncate font-mono text-xs font-normal">
            {dir && <span className="text-muted-foreground max-sm:hidden">{dir}/</span>}
            {name}
          </Title>
        </div>
        {url && (
          <Button variant="ghost" size="sm" asChild>
            <a href={url} target="_blank" rel="noreferrer" aria-label="Abrir no claude.ai" title="Abrir no claude.ai">
              <ClaudeMark className="size-3.5" />
              <span className="max-sm:hidden">claude.ai</span>
            </a>
          </Button>
        )}
        {view && (
          <Button variant="ghost" size="icon" asChild>
            <a href={view} target="_blank" rel="noreferrer" aria-label="Abrir numa janela" title="Abrir numa janela">
              <ExternalLink />
            </a>
          </Button>
        )}
      </header>
      <div className={cn('relative flex min-h-0 flex-1 flex-col', src ? 'bg-white' : 'bg-background')}>
        {src ? (
          // Um iframe novo a cada versão, em vez de trocar o `src`: trocar empilharia a página no histórico, e o voltar a desfaria.
          <iframe
            key={src}
            ref={frame}
            src={src}
            title={title || name}
            sandbox={SANDBOX}
            onLoad={() => setLoaded(src)}
            className={cn('absolute inset-0 size-full border-0 bg-white', dragging && 'pointer-events-none')}
          />
        ) : error ? (
          <Problem error={error} onRetry={reload} />
        ) : (
          <Skeleton className="absolute inset-3 rounded-xl" />
        )}
      </div>
    </>
  )
}

/**
 * A página aberta pelo chat ou pela árvore de arquivos no celular: ocupa a tela toda, e o voltar fecha.
 * No PC, ela abre como aba (ver lib/prototype.ts).
 */
export function PrototypeDialog() {
  const page = usePrototypeDialog((s) => s.open)
  const wide = useWide()
  if (wide) return null
  return (
    <Dialog open={page !== null} onOpenChange={(o) => !o && closePrototypeDialog()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-dvh w-screen max-w-none flex-col gap-0 rounded-none border-0 p-0 pb-[env(safe-area-inset-bottom)] ring-0 sm:max-w-none"
      >
        {page && <PrototypeView key={`${page.machine}\n${page.path}`} {...page} active dialog />}
      </DialogContent>
    </Dialog>
  )
}
