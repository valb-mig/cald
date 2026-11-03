import { FolderGit2, Inbox, Loader2, MessagesSquare, Monitor } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { setComputerOpen } from '@/lib/computer'
import { useInboxCount } from '@/lib/inbox'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

// Sem início: no celular, o app abre nas conversas (ver App.tsx).
const TABS = [
  { href: '/conversas', label: 'Conversas', icon: MessagesSquare },
  { href: '/inbox', label: 'Inbox', icon: Inbox },
  { href: '/projetos', label: 'Projetos', icon: FolderGit2 },
]
const tabClass =
  'relative flex h-12 flex-col items-center justify-center gap-0.5 rounded-full text-[11px] transition-colors duration-200 compact:h-14 compact:rounded-[1.25rem]'

/**
 * Abas do celular numa pílula solta na casca, embaixo da página, com margem em volta (longe da barra de
 * gestos); deitado, uma coluna na lateral para sobrar altura. A aberta ganha um fundo claro dentro da
 * pílula. A última, Computador, abre o painel por cima em vez de trocar de tela (ver lib/computer.ts).
 */
export function BottomNav() {
  const [location] = useLocation()
  const attention = useStore((s) => s.catalog.reduce((n, c) => n + (c.state === 'waiting' ? 1 : 0), 0))
  const inbox = useInboxCount()
  return (
    <nav className="m-frame mb-[max(var(--frame),env(safe-area-inset-bottom))] grid shrink-0 grid-cols-4 gap-1 rounded-full bg-background p-1 shadow-island compact:w-20 compact:grid-cols-1 compact:content-center compact:rounded-[1.5rem]">
      {TABS.map(({ href, label, icon: Icon }) => {
        const active =
          href === '/conversas'
            ? location.startsWith('/conversas') || location.startsWith('/s/') || location === '/nova'
            : location.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            className={cn(tabClass, active ? 'bg-foreground/[0.08] font-medium text-foreground' : 'text-muted-foreground active:bg-foreground/5')}
          >
            <Icon className="size-5" />
            {label}
            {href === '/conversas' && attention > 0 && (
              <span className="absolute top-1 left-1/2 ml-2 min-w-4 rounded-full bg-amber-500 px-1 text-center text-[10px] leading-4 font-semibold text-white">
                {attention}
              </span>
            )}
            {/* Os novos da inbox (nem vistos nem adiados), em azul: o âmbar é de quem espera você. */}
            {href === '/inbox' && inbox > 0 && (
              <span className="absolute top-1 left-1/2 ml-2 min-w-4 rounded-full bg-sky-600 px-1 text-center text-[10px] leading-4 font-semibold text-white">
                {inbox > 99 ? '99+' : inbox}
              </span>
            )}
          </Link>
        )
      })}
      <button type="button" onClick={() => setComputerOpen(true)} className={cn(tabClass, 'text-muted-foreground active:bg-foreground/5')}>
        <Monitor className="size-5" />
        Computador
      </button>
    </nav>
  )
}

/** Faixa no topo quando o WebSocket cai; espera um instante para não piscar em reconexões rápidas. */
export function ConnectionBanner() {
  const connection = useStore((s) => s.connection)
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (connection === 'open') {
      setShow(false)
      return
    }
    const t = setTimeout(() => setShow(true), 1500)
    return () => clearTimeout(t)
  }, [connection])
  if (!show) return null
  return (
    // Uma pílula no alto da casca, acima da janela; no celular, com margem e longe do entalhe (ver App.tsx).
    <div
      data-banner
      className="mx-frame mt-[max(var(--frame),env(safe-area-inset-top))] mb-gap flex shrink-0 items-center justify-center gap-2 rounded-pane bg-amber-500/15 px-3 py-1.5 text-xs text-amber-800 wide:mx-0 wide:mt-0 dark:text-amber-300"
    >
      <Loader2 className="size-3 animate-spin" />
      Sem conexão com o PC. Reconectando…
    </div>
  )
}

/** `className`: na lista da barra lateral (no PC), o fundo do cabeçalho passa a ser o da ilha dela. */
export function PageHeader({ title, action, className }: { title: string; action?: React.ReactNode; className?: string }) {
  return (
    <header
      className={cn(
        'sticky top-0 z-10 flex items-center justify-between gap-2 bg-background/95 px-4 pt-[max(0.75rem,var(--safe-top))] pb-3 backdrop-blur compact:py-2',
        className,
      )}
    >
      <h1 className="text-lg font-semibold">{title}</h1>
      {action}
    </header>
  )
}
