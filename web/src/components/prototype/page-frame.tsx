import { ArrowLeft, RotateCw, type LucideIcon } from 'lucide-react'
import { createElement, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useGlass } from '@/lib/wallpaper'

/**
 * O que a página pode no iframe. Nunca `allow-same-origin`: escrita pelo Claude, ela roda com origem
 * opaca e não alcança a API do edit.r nem o que o app guarda. O PC manda a mesma CSP (ver server/src/prototypes.ts).
 */
export const PAGE_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads'

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

type Props = {
  /** A página no iframe; sem ela, `problem` ou, carregando, o esqueleto. */
  src: string | null
  /** O nome da página, para o leitor de tela. */
  title: string
  /** No celular, em tela cheia: com o voltar (`onBack`), e o endereço vira o título do diálogo. */
  dialog?: boolean
  onBack?: () => void
  onReload: () => void
  /** Pedindo a página de novo: o recarregar gira, como enquanto o iframe carrega. */
  busy?: boolean
  /** Um toque dentro da página: ela não chega ao app (é do iframe), então quem a mostra é avisado assim. */
  onInteract?: () => void
  /** No lugar da página, quando ela não abre. */
  problem?: React.ReactNode
  /** A barra de endereço: o ícone, o que ela diz (só para ler), a dica e, no fim dela, um selo. */
  icon: LucideIcon
  address: React.ReactNode
  hint?: string
  badge?: React.ReactNode
  /** Os botões depois do endereço. */
  actions?: React.ReactNode
}

/**
 * Uma página num mini-navegador: a barra (recarregar, o endereço e as ações de quem a mostra) e a página
 * num iframe isolado. Serve a página viva do Claude (ver prototype-view.tsx) e as versões dos artefatos
 * (ver components/artefatos/artefato-view.tsx).
 */
export function PageFrame({ src, title, dialog = false, onBack, onReload, busy = false, onInteract, problem, icon, address, hint, badge, actions }: Props) {
  const [loaded, setLoaded] = useState<string | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const dragging = useDragging()
  const glass = useGlass() && !dialog

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

  const spinning = busy || Boolean(src && loaded !== src)
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
        {dialog && onBack && (
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Voltar">
            <ArrowLeft />
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={onReload} disabled={busy} aria-label="Recarregar" title="Recarregar">
          <RotateCw className={cn(spinning && 'animate-spin')} />
        </Button>
        {/* O endereço, só para ler, como a barra de um navegador. */}
        <div title={hint} className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full bg-foreground/[0.05] px-3">
          {createElement(icon, { className: 'size-3.5 shrink-0 text-muted-foreground' })}
          <Title className="min-w-0 flex-1 truncate text-xs font-normal">{address}</Title>
          {badge}
        </div>
        {actions}
      </header>
      <div className={cn('relative flex min-h-0 flex-1 flex-col', src ? 'bg-white' : 'bg-background')}>
        {src ? (
          // Um iframe novo a cada página, em vez de trocar o `src`: trocar empilharia a página no histórico, e o voltar a desfaria.
          <iframe
            key={src}
            ref={frame}
            src={src}
            title={title}
            sandbox={PAGE_SANDBOX}
            onLoad={() => setLoaded(src)}
            className={cn('absolute inset-0 size-full border-0 bg-white', dragging && 'pointer-events-none')}
          />
        ) : (
          (problem ?? <Skeleton className="absolute inset-3 rounded-xl" />)
        )}
      </div>
    </>
  )
}

/** No lugar da página: o ícone apagado, o que houve e o que fazer. */
export function PageProblem({ icon, text, children }: { icon: LucideIcon; text: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      {createElement(icon, { className: 'size-8 text-muted-foreground/60' })}
      <p className="max-w-xs text-sm text-muted-foreground">{text}</p>
      {children}
    </div>
  )
}
