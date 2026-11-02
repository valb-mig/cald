import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Group } from '@/components/settings-ui'
import { ApiError, api, errorMessage } from '@/lib/api'
import type { UpdateStatus, UpdateStep } from '@/lib/types'

const STEPS: Record<UpdateStep, string> = {
  fetch: 'Baixando do GitHub…',
  switch: 'Trocando para a main…',
  merge: 'Atualizando os arquivos…',
  install: 'Instalando dependências…',
  build: 'Compilando o app…',
  restart: 'Reiniciando o servidor…',
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  )
}

/**
 * Atualizar o PC daqui: puxa a main do GitHub, instala, compila e reinicia o serviço. Durante o
 * reinício o servidor some por alguns segundos; quando volta, o app procura a versão nova.
 */
export function UpdateCard({ machine }: { machine: string }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [starting, setStarting] = useState(false)
  // Pediu o reinício e o servidor ainda não voltou.
  const [restarting, setRestarting] = useState(false)
  // Servidor de antes desta versão, sem as rotas de atualização: o cartão não aparece.
  const [missing, setMissing] = useState(false)

  const load = useCallback(async () => {
    try {
      const next = await api.update(machine)
      setStatus(next)
      setError(null)
      if (next.job?.step === 'restart' && !next.job.done) setRestarting(true)
      return next
    } catch (err) {
      setError(errorMessage(err))
      return null
    }
  }, [machine])

  useEffect(() => {
    api.update(machine).then(setStatus, (err) => {
      if (err instanceof ApiError && err.status === 404) setMissing(true)
      else setError(errorMessage(err))
    })
  }, [machine])

  const job = status?.job
  const running = Boolean(job && !job.error && !job.done)
  // Acompanha a atualização; no reinício, insiste até o servidor voltar.
  useEffect(() => {
    if (!running && !restarting) return
    const timer = setInterval(async () => {
      const next = await load()
      // Servidor de volta sem trabalho em andamento: é o processo novo, depois do reinício.
      if (next && !next.job) {
        setRestarting(false)
        toast.success('PC atualizado')
        // O service worker novo traz o app novo; o aviso "Versão nova do app" aparece em seguida.
        void navigator.serviceWorker?.getRegistration().then((reg) => reg?.update())
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [running, restarting, load])

  async function start() {
    setStarting(true)
    try {
      setStatus(await api.startUpdate(machine))
    } catch (err) {
      toast.error(errorMessage(err))
      void load()
    } finally {
      setStarting(false)
    }
  }

  async function restartNow() {
    try {
      await api.restartNow(machine)
      setRestarting(true)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const onMain = status?.branch === status?.target
  const upToDate = Boolean(status && onMain && status.behind === 0)
  const blocked = Boolean(status && (status.dirty || (onMain && status.ahead > 0) || status.busy.length > 0))
  const postponed = job?.error === 'restart_postponed'

  if (missing) return null
  return (
    <Group title="Atualização do PC">
      <div className="space-y-3 px-3 py-2.5 text-sm">
        {status && (
          <p className="truncate text-xs text-muted-foreground">
            Na {status.branch ?? 'versão solta'} · <span className="font-mono">{status.head.sha}</span> {status.head.subject}
          </p>
        )}
        {error && !restarting && !running && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

        {restarting || running ? (
          <p className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
            {restarting ? STEPS.restart : STEPS[job!.step]}
          </p>
        ) : postponed ? (
          <div className="space-y-2">
            <Warning>Compilado, mas uma conversa começou a trabalhar: o reinício ficou para depois.</Warning>
            <Button size="sm" onClick={() => void restartNow()}>
              Reiniciar agora
            </Button>
          </div>
        ) : job?.error ? (
          <div className="space-y-1">
            <p className="text-xs text-red-600 dark:text-red-400">
              Falhou em "{STEPS[job.step].replace('…', '')}": {job.error}
            </p>
            {job.log && <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-[11px] whitespace-pre-wrap">{job.log}</pre>}
          </div>
        ) : job?.done ? (
          <Warning>Compilado. O servidor não roda como serviço: reinicie pelo terminal para usar a versão nova.</Warning>
        ) : null}

        {status && !running && !restarting && (
          <>
            {status.fetchError && <Warning>Não deu para consultar o GitHub: {status.fetchError}</Warning>}
            {upToDate ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
                Em dia com a main do GitHub.
              </p>
            ) : (
              status.incoming.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    {status.behind === 1 ? '1 novidade' : `${status.behind} novidades`} na main:
                  </p>
                  <ul className="space-y-0.5 text-xs">
                    {status.incoming.map((c) => (
                      <li key={c.sha} className="truncate">
                        <span className="font-mono text-muted-foreground">{c.sha}</span> {c.subject}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            )}
            {!onMain && status.branch !== null && (
              <Warning>
                O PC está na branch <span className="font-mono">{status.branch}</span>: atualizar troca para a main.
              </Warning>
            )}
            {status.dirty && <Warning>O repositório no PC tem mudanças não commitadas: atualize pelo terminal.</Warning>}
            {onMain && status.ahead > 0 && <Warning>A main do PC tem commits que não estão no GitHub: resolva pelo terminal.</Warning>}
            {status.busy.length > 0 && <Warning>Esperando terminar: {status.busy.join(', ')}.</Warning>}
            {!status.canRestart && <Warning>O servidor não roda como serviço: depois de compilar, reinicie pelo terminal.</Warning>}
            <div className="flex gap-2">
              {!upToDate && (
                <Button size="sm" disabled={blocked || starting} onClick={() => setConfirm(true)}>
                  {starting ? <Loader2 className="animate-spin" /> : <Download />} Atualizar e reiniciar
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => void load()}>
                <RefreshCw /> Verificar
              </Button>
            </div>
          </>
        )}
      </div>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Atualizar e reiniciar o PC?</AlertDialogTitle>
            <AlertDialogDescription>
              O painel fica fora do ar por alguns segundos. As conversas abertas aqui são reabertas sozinhas, com o mesmo modelo e modo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void start()}>Atualizar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Group>
  )
}
