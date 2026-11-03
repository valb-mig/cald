import { ArrowLeft, FileText, Loader2, MessageSquarePlus, Share2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Link, useLocation } from 'wouter'
import { StateBadge } from '@/components/state-badge'
import { Button } from '@/components/ui/button'
import { toAttachment } from '@/lib/attachments'
import { kvDel, kvGet } from '@/lib/db'
import { loadDraft, putDraft } from '@/lib/drafts'
import { projectName, relativeTime } from '@/lib/format'
import { SHARE_KEY, type Shared } from '@/lib/share'
import { useStore } from '@/lib/store'
import { backHref } from '@/lib/tabs'

const RECENT_LIMIT = 30

/** Texto que veio junto: título, texto e link, sem repetir o link que já está no texto. */
function sharedText(s: Shared): string {
  const parts = [s.title, s.text].filter((p): p is string => Boolean(p?.trim()))
  const url = s.url?.trim()
  if (url && !parts.some((p) => p.includes(url))) parts.push(url)
  return parts.join('\n')
}

function Preview({ shared }: { shared: Shared }) {
  const [urls] = useState(() => shared.files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null)))
  useEffect(() => () => urls.forEach((u) => u && URL.revokeObjectURL(u)), [urls])
  const text = sharedText(shared)
  return (
    <div className="space-y-2 border-b px-4 py-3">
      {shared.files.length > 0 && (
        <div className="flex gap-2 overflow-x-auto">
          {shared.files.map((f, i) =>
            urls[i] ? (
              <img key={i} src={urls[i]!} alt={f.name} className="size-20 shrink-0 rounded-md border object-cover" />
            ) : (
              <div key={i} className="flex h-20 w-32 shrink-0 flex-col justify-center gap-1 rounded-md border bg-muted/40 px-2 text-xs">
                <FileText className="size-4 text-muted-foreground" />
                <span className="truncate font-medium">{f.name}</span>
              </div>
            ),
          )}
        </div>
      )}
      {text && <p className="line-clamp-4 text-sm whitespace-pre-wrap break-words text-muted-foreground">{text}</p>}
    </div>
  )
}

/**
 * Destino do "Compartilhar" do Android (share_target do manifesto; o service worker guarda o que
 * chegou). Escolher a conversa põe tudo no rascunho dela, para revisar antes de enviar.
 */
export function SharePage() {
  const [, navigate] = useLocation()
  const catalog = useStore((s) => s.catalog)
  const [shared, setShared] = useState<Shared | null>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    kvGet<Shared>(SHARE_KEY).then(
      (s) => setShared(s ?? null),
      () => setShared(null),
    )
  }, [])

  async function deliver(draftId: string, path: string) {
    if (!shared) return
    setBusy(true)
    try {
      const results = await Promise.allSettled(shared.files.map(toAttachment))
      for (const r of results) if (r.status === 'rejected') toast.error(String((r.reason as Error).message ?? r.reason))
      const attachments = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      const before = await loadDraft(draftId)
      const text = [before?.text, sharedText(shared)].filter(Boolean).join('\n\n')
      await putDraft(draftId, { text, attachments: [...(before?.attachments ?? []), ...attachments] })
      await kvDel(SHARE_KEY)
      navigate(path, { replace: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-1 px-2 pt-[max(0.5rem,var(--safe-top))] pb-2">
        <Button variant="ghost" size="icon" asChild aria-label="Voltar">
          <Link href={backHref()}>
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Compartilhar com o Claude</div>
          <div className="text-xs text-muted-foreground">Escolha a conversa; nada é enviado antes de você revisar.</div>
        </div>
        {busy && <Loader2 className="mr-2 size-4 animate-spin text-muted-foreground" />}
      </header>

      {shared === undefined ? null : shared === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <Share2 className="size-8 text-muted-foreground" />
          <p className="text-sm">Nada para compartilhar.</p>
          <p className="text-xs text-muted-foreground">No Android, use "Compartilhar" em outro app e escolha o cald.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Preview shared={shared} />
          <button
            type="button"
            disabled={busy}
            onClick={() => void deliver('new:~', '/nova')}
            className="flex w-full items-center gap-3 border-b px-4 py-3 text-left active:bg-muted disabled:opacity-50"
          >
            <MessageSquarePlus className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium">Nova conversa</span>
          </button>
          <div className="divide-y">
            {catalog.slice(0, RECENT_LIMIT).map((s) => (
              <button
                key={s.sessionId}
                type="button"
                disabled={busy}
                onClick={() => void deliver(s.sessionId, `/s/${s.sessionId}`)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left active:bg-muted disabled:opacity-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{s.title}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate">{projectName(s.cwd)}</span>
                    <span>·</span>
                    <span className="shrink-0">{relativeTime(s.lastModified)}</span>
                  </div>
                </div>
                {s.state !== 'stopped' && <StateBadge state={s.state} waitingFor={s.waitingFor} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
