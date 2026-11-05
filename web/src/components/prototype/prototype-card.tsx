import { AppWindow } from 'lucide-react'
import { ClaudeMark } from '@/components/claude-mark'
import { splitPath } from '@/components/project/status'
import { shortPath } from '@/lib/format'
import { machineOf } from '@/lib/machines'
import { showPrototype, type PublishedPage } from '@/lib/prototype'
import { useStore } from '@/lib/store'

/**
 * A página que o Claude publicou, à vista no chat como as imagens devolvidas: o título (a descrição dele,
 * ou o arquivo), o abrir (no PC, numa aba; no celular, em tela cheia) e, ao lado, o artifact no claude.ai.
 */
export function PrototypeCard({ sessionId, page }: { sessionId: string; page: PublishedPage }) {
  const cwd = useStore((s) => s.catalog.find((c) => c.sessionId === sessionId)?.cwd)
  const { name } = splitPath(page.path)
  const open = () => showPrototype({ machine: machineOf(sessionId), cwd, path: page.path, url: page.url, title: page.title })
  return (
    <div className="flex max-w-md items-center gap-1 rounded-xl bg-foreground/[0.04] p-1">
      <button
        type="button"
        onClick={open}
        title={shortPath(page.path)}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1 pr-1.5 pl-1 text-left transition-colors hover:bg-foreground/[0.04]"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background">
          <AppWindow className="size-4 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{page.title || name}</span>
          {page.title && <span className="block truncate font-mono text-[11px] text-muted-foreground">{name}</span>}
        </span>
        <span className="shrink-0 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">Abrir</span>
      </button>
      {page.url && (
        <a
          href={page.url}
          target="_blank"
          rel="noreferrer"
          aria-label="Abrir no claude.ai"
          title="Abrir no claude.ai"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-foreground/[0.06]"
        >
          <ClaudeMark className="size-4" />
        </a>
      )}
    </div>
  )
}
