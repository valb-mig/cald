import { Pause, Play, X } from 'lucide-react'
import { Slider } from 'radix-ui'
import { useState } from 'react'
import { Claudinho } from '@/components/claudinho'
import { Button } from '@/components/ui/button'
import { claudinhoName } from '@/lib/claudinho'
import { SPEEDS, pauseSpeech, resumeSpeech, seekSpeech, setSpeechRate, stopSpeaking, useSpeech } from '@/lib/speech'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { useGlass } from '@/lib/wallpaper'

const STEPS = 1000

const speedLabel = (rate: number) => `${rate.toLocaleString('pt-BR')}x`

/**
 * A leitura em voz alta, numa ilha logo acima da caixa de mensagem e na largura dela: o claudinho da
 * conversa (piscando enquanto lê), pausar e continuar, a frase que está sendo lida, em qual delas está
 * e até onde já leu. Tocar ou arrastar na barra pula para outra frase, e a velocidade passa por 1x,
 * 1,5x, 2x e 3x.
 */
export function SpeechPlayer({ sessionId }: { sessionId: string }) {
  // Com conversas lado a lado, a barra aparece só na conversa que está sendo lida.
  const reading = useSpeech((s) => (s.reading?.key.startsWith(`${sessionId}:`) ? s.reading : null))
  // Enquanto arrasta, a barra segue o dedo; a leitura só pula ao soltar.
  const [dragging, setDragging] = useState<number | null>(null)
  const glass = useGlass()
  const rate = useSpeech((s) => s.rate)
  const custom = useStore((s) => s.catalog.find((c) => c.sessionId === sessionId)?.claudinhoName)
  if (!reading) return null
  const name = claudinhoName(sessionId, custom)
  const next = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length]!
  const value = dragging ?? reading.progress
  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-2 pt-2 wide:px-4">
      <div
        role="region"
        aria-label={`${name} lendo em voz alta`}
        className={cn(
          'flex items-center gap-2.5 rounded-2xl border py-1.5 pr-1.5 pl-2 shadow-[0_12px_32px_-18px_rgb(0_0_0/0.35)]',
          glass ? 'bg-card/70 backdrop-blur-md' : 'bg-card',
        )}
      >
        <Claudinho seed={sessionId} name={name} state={reading.playing ? 'running' : 'idle'} size={26} className="compact:hidden" />
        <Button
          size="icon"
          className="size-8 shrink-0 rounded-full"
          onClick={reading.playing ? pauseSpeech : resumeSpeech}
          aria-label={reading.playing ? 'Pausar a leitura' : 'Continuar a leitura'}
        >
          {reading.playing ? <Pause className="size-3.5 fill-current" /> : <Play className="ml-0.5 size-3.5 fill-current" />}
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 compact:hidden">
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{reading.units[reading.index]?.text}</p>
            <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">
              {reading.index + 1}/{reading.units.length}
            </span>
          </div>
          <Slider.Root
            value={[Math.round(value * STEPS)]}
            max={STEPS}
            onValueChange={([v]) => setDragging(v / STEPS)}
            onValueCommit={([v]) => {
              setDragging(null)
              seekSpeech(v / STEPS)
            }}
            className="group/seek relative flex h-4 touch-none items-center select-none"
          >
            <Slider.Track className="relative h-[3px] grow overflow-hidden rounded-full bg-foreground/10">
              <Slider.Range className="absolute h-full rounded-full bg-foreground/70" />
            </Slider.Track>
            {/* A bolinha só aparece para mexer: ao passar o mouse, arrastando ou com foco do teclado. */}
            <Slider.Thumb
              aria-label="Até onde já leu"
              className="block size-3 rounded-full bg-foreground opacity-0 shadow transition-opacity outline-none group-hover/seek:opacity-100 focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 active:opacity-100 pointer-coarse:opacity-100"
            />
          </Slider.Root>
        </div>
        <button
          type="button"
          // Largura fixa: trocar de 1x para 1,5x não empurra a barra.
          className={cn(
            'h-7 w-11 shrink-0 rounded-full text-xs tabular-nums transition-colors',
            rate === 1 ? 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground' : 'bg-foreground/10 font-semibold text-foreground',
          )}
          onClick={() => setSpeechRate(next)}
          aria-label={`Velocidade ${speedLabel(rate)}: tocar para ${speedLabel(next)}`}
        >
          {speedLabel(rate)}
        </button>
        <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" onClick={stopSpeaking} aria-label="Fechar a leitura">
          <X />
        </Button>
      </div>
    </div>
  )
}
