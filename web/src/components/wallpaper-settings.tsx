import { Check } from 'lucide-react'
import { Scene } from '@/components/wallpaper/wallpaper'
import { THEMES } from '@/components/wallpaper/themes'
import { Group, Segmented } from '@/components/settings-ui'
import { cn } from '@/lib/utils'
import { INTENSITIES, setWallpaper, useWallpaper, type ThemeId } from '@/lib/wallpaper'

const tileClass =
  'relative h-14 overflow-hidden rounded-lg text-left outline-none transition-shadow hover:ring-1 hover:ring-foreground/30 focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground'

/** Nome do tema por cima da miniatura, numa tarja que o fundo animado não apaga. */
function Tag({ children, picked }: { children: React.ReactNode; picked: boolean }) {
  return (
    <span className="absolute bottom-1 left-1 flex max-w-[calc(100%-0.5rem)] items-center gap-1 truncate rounded bg-background/85 px-1.5 py-0.5 text-[11px] font-medium backdrop-blur-sm">
      {picked && <Check className="size-3 text-primary" />}
      {children}
    </span>
  )
}

/** Escolhe o fundo animado da conversa; as miniaturas são a própria cena rodando. */
export function WallpaperSettings() {
  const { theme, intensity } = useWallpaper()
  const pick = (id: ThemeId) => setWallpaper({ theme: id })
  const current = THEMES.find((t) => t.id === theme)

  return (
    <Group
      title="Fundo da conversa"
      note={current ? current.hint : 'Desenho em ASCII atrás das mensagens, só neste aparelho. Congela quando sai da tela.'}
      className="space-y-2 p-2"
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <button type="button" aria-pressed={theme === 'none'} onClick={() => pick('none')} className={cn(tileClass, 'bg-foreground/[0.06]')}>
          <Tag picked={theme === 'none'}>Nenhum</Tag>
        </button>
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={theme === t.id}
            aria-label={`${t.name}: ${t.hint}`}
            onClick={() => pick(t.id)}
            className={tileClass}
          >
            <Scene id={t.id} zoom={0.5} className="absolute inset-0" />
            <Tag picked={theme === t.id}>{t.name}</Tag>
          </button>
        ))}
      </div>

      {current && (
        <div className="flex items-center gap-3 px-1 pt-1">
          <span className="shrink-0 text-xs text-muted-foreground">Força</span>
          <Segmented
            value={intensity}
            options={INTENSITIES.map((i) => ({ key: i.key, label: i.label }))}
            onChange={(i) => setWallpaper({ intensity: i })}
            className="flex-1"
          />
        </div>
      )}
    </Group>
  )
}
