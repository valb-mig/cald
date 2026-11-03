import { ArrowLeft, Maximize, Minimize, Sun, SunDim } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Link, useSearch } from 'wouter'
import { useDemoOffice } from '@/components/office/demo'
import { VectorOffice } from '@/components/office/vector/office'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useOffice } from '@/lib/office'
import { backHref } from '@/lib/tabs'
import type { OfficeRoom } from '@/lib/types'

const minute = () => Math.floor(Date.now() / 60_000) * 60_000
const everyMinute = (onChange: () => void) => {
  const timer = setInterval(onChange, 15_000)
  return () => clearInterval(timer)
}

/** Pede você (0), trabalha (1), tem algo em segundo plano (2) ou descansa (3): para o resumo do topo. */
function rank(room: OfficeRoom): number {
  const lead = room.workers[0]?.activity
  if (room.state === 'waiting' || lead === 'ask') return 0
  if (room.state === 'running') return 1
  if (lead === 'background') return 2
  return 3
}

/** Tela ligada enquanto a salinha está aberta (opcional: para deixar de fundo num tablet ou monitor). */
function useWakeLock(): { supported: boolean; on: boolean; toggle: () => void } {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator
  const [on, setOn] = useState(false)
  const sentinel = useRef<WakeLockSentinel | null>(null)
  useEffect(() => {
    if (!on) return
    let alive = true
    const acquire = () =>
      navigator.wakeLock.request('screen').then(
        (s) => (alive ? (sentinel.current = s) : void s.release()),
        () => setOn(false),
      )
    void acquire()
    // O sistema solta a trava quando a aba some; volta a pedir quando ela reaparece.
    const onVisible = () => document.visibilityState === 'visible' && void acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
      void sentinel.current?.release()
      sentinel.current = null
    }
  }, [on])
  return { supported, on, toggle: () => setOn((v) => !v) }
}

function useFullscreen(): { on: boolean; toggle: () => void } {
  const on = useSyncExternalStore(
    (onChange) => {
      document.addEventListener('fullscreenchange', onChange)
      return () => document.removeEventListener('fullscreenchange', onChange)
    },
    () => document.fullscreenElement !== null,
  )
  return { on, toggle: () => void (on ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}) }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * A salinha: um prédio de escritórios onde cada conversa aberta é uma área, com o gestor (a
 * conversa) e os funcionários (os subagentes) indo até a estação do que estão fazendo. Para deixar de fundo.
 */
export function OfficePage() {
  // `?demo`: um escritório de mentira, cheio, para ver como fica; `?hora=21` e `?chuva` mudam o céu.
  const params = new URLSearchParams(useSearch())
  const demo = params.has('demo')
  const hour = params.has('hora') ? Number(params.get('hora')) : NaN
  const rain = params.has('chuva')
  const clock = useMemo(() => ({ hour: hour >= 0 && hour < 24 ? hour : undefined, rain }), [hour, rain])
  const live = useOffice()
  const fake = useDemoOffice(demo)
  const rooms = demo ? fake : live
  const now = useSyncExternalStore(everyMinute, minute)
  const wake = useWakeLock()
  const full = useFullscreen()
  const counts = useMemo(() => {
    const ranks = (rooms ?? []).map(rank)
    return { asking: ranks.filter((r) => r === 0).length, working: ranks.filter((r) => r === 1 || r === 2).length, resting: ranks.filter((r) => r === 3).length }
  }, [rooms])
  const workers = (rooms ?? []).reduce((n, r) => n + r.workers.length, 0)

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
        <Button variant="ghost" size="icon" asChild aria-label="Voltar">
          <Link href={backHref()}>
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">Salinha{demo && ' · demonstração'}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {rooms
              ? [
                  counts.asking > 0 && `${plural(counts.asking, 'pede', 'pedem')} você`,
                  counts.working > 0 && plural(counts.working, 'área trabalhando', 'áreas trabalhando'),
                  counts.resting > 0 && plural(counts.resting, 'descansando', 'descansando'),
                  workers > 0 && plural(workers, 'claudinho', 'claudinhos'),
                ]
                  .filter(Boolean)
                  .join(' · ') || 'Ninguém no escritório'
              : 'Abrindo o escritório…'}
          </p>
        </div>
        <span className="hidden px-1 text-sm text-muted-foreground tabular-nums sm:inline">
          {new Date(now).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
        </span>
        {wake.supported && (
          <Button
            variant={wake.on ? 'secondary' : 'ghost'}
            size="icon"
            onClick={wake.toggle}
            aria-pressed={wake.on}
            aria-label={wake.on ? 'Tela acesa: tocar para deixar apagar' : 'Manter a tela acesa'}
            title={wake.on ? 'Tela acesa' : 'Manter a tela acesa'}
          >
            {wake.on ? <Sun /> : <SunDim />}
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={full.toggle} aria-label={full.on ? 'Sair da tela cheia' : 'Tela cheia'} title={full.on ? 'Sair da tela cheia' : 'Tela cheia'}>
          {full.on ? <Minimize /> : <Maximize />}
        </Button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {!rooms ? (
          <Skeleton className="mx-auto aspect-[3/1.3] w-full max-w-3xl rounded-xl" />
        ) : (
          <>
            <VectorOffice rooms={rooms} clock={clock} />
            {rooms.length === 0 && (
              <p className="p-6 text-center text-sm text-muted-foreground">
                Nenhuma conversa aberta. Quando você abrir uma, no celular ou no PC, ela ganha um cômodo aqui.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  )
}
