import { AppWindow, ExternalLink, FileX, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ClaudeMark } from '@/components/claude-mark'
import { splitPath } from '@/components/project/status'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { api, ApiError, errorMessage, isOutdatedServer, OUTDATED_SERVER, prototypeViewUrl } from '@/lib/api'
import { shortPath } from '@/lib/format'
import { useWide } from '@/lib/hooks'
import { closePrototypeDialog, usePrototypeDialog, type PrototypeRef } from '@/lib/prototype'
import type { PrototypeOpen } from '@/lib/types'
import { PageFrame, PageProblem } from './page-frame'

/** De quanto em quanto tempo a aba à vista pergunta se o Claude mexeu na página. */
const POLL_MS = 2000

/** No lugar da página: o arquivo que sumiu, ou o que o PC recusou, e o tentar de novo. */
function Problem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  // O `not_found` puro é o do servidor que ainda não tem a rota; a página que sumiu tem código próprio.
  const gone = error instanceof ApiError && error.code === 'prototype_not_found'
  return (
    <PageProblem
      icon={gone ? FileX : TriangleAlert}
      text={gone ? 'A página não está mais no PC.' : isOutdatedServer(error) ? OUTDATED_SERVER : errorMessage(error)}
    >
      <Button size="sm" variant="outline" onClick={onRetry}>
        Tentar de novo
      </Button>
    </PageProblem>
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
  // A versão vai na URL: o iframe novo (ver PageFrame) não reaproveita a página velha do cache.
  const src = page && view ? `${view}?v=${Math.round(page.mtime)}${reloads ? `.${reloads}` : ''}` : null
  const { name, dir } = splitPath(shortPath(path))

  return (
    <PageFrame
      src={src}
      title={title || name}
      dialog={dialog}
      onBack={closePrototypeDialog}
      onReload={reload}
      busy={busy}
      onInteract={onInteract}
      problem={error ? <Problem error={error} onRetry={reload} /> : undefined}
      icon={AppWindow}
      // A pasta apagada e o arquivo, como a barra de um navegador.
      address={
        <span className="font-mono">
          {dir && <span className="text-muted-foreground max-sm:hidden">{dir}/</span>}
          {name}
        </span>
      }
      hint={title ? `${title}\n${shortPath(path)}` : shortPath(path)}
      actions={
        <>
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
        </>
      }
    />
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
