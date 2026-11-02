import { useRef, useState } from 'react'
import { Check, ImagePlus, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { forgetImageTheme } from '@/components/wallpaper/image'
import { ImageScene, Photo, Scene } from '@/components/wallpaper/wallpaper'
import { THEMES } from '@/components/wallpaper/themes'
import { Group, Segmented } from '@/components/settings-ui'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { INTENSITIES, setWallpaper, useWallpaper, type ThemeId } from '@/lib/wallpaper'
import { addImage, removeImage, setImageStyle, STYLES, useWallpaperImages } from '@/lib/wallpaper-images'

const tileClass =
  'relative h-14 overflow-hidden rounded-lg text-left outline-none transition-shadow hover:ring-1 hover:ring-foreground/30 focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground'

/** Nome do tema por cima da miniatura, numa tarja que o fundo animado não apaga. */
function Tag({ children, picked }: { children: React.ReactNode; picked: boolean }) {
  return (
    <span className="absolute bottom-1 left-1 flex max-w-[calc(100%-0.5rem)] items-center gap-1 truncate rounded bg-background/85 px-1.5 py-0.5 text-[11px] font-medium backdrop-blur-sm">
      {picked && <Check className="size-3 shrink-0 text-primary" />}
      <span className="truncate">{children}</span>
    </span>
  )
}

const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')

/**
 * Escolhe o fundo animado da conversa; as miniaturas são a própria cena rodando. Dá para pôr uma imagem
 * sua, pelo botão ou soltando o arquivo nas miniaturas: ela entra na lista e já fica escolhida.
 */
export function WallpaperSettings() {
  const { theme, intensity } = useWallpaper()
  const images = useWallpaperImages((s) => s.items)
  const pick = (id: ThemeId) => setWallpaper({ theme: id })
  const current = THEMES.find((t) => t.id === theme)
  const image = images.find((i) => i.id === theme)
  const input = useRef<HTMLInputElement>(null)
  const [adding, setAdding] = useState(false)

  const add = async (file: File | undefined) => {
    if (!file || adding) return
    setAdding(true)
    try {
      pick((await addImage(file)).id)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setAdding(false)
    }
  }

  const remove = () => {
    if (!image) return
    removeImage(image.id)
    forgetImageTheme(image.id)
  }

  const note = image
    ? image.style === 'photo'
      ? 'Sua imagem como está, atrás das mensagens. Fica só neste aparelho.'
      : 'Sua imagem em caracteres, que acendem perto do ponteiro. Fica só neste aparelho.'
    : current
      ? current.hint
      : 'Desenho em ASCII ou uma imagem sua atrás das mensagens, só neste aparelho. Congela quando sai da tela.'

  return (
    <Group title="Fundo da conversa" note={note} className="space-y-2 p-2">
      <div
        className="grid grid-cols-2 gap-2 sm:grid-cols-3"
        onDragOver={(e) => {
          if (!hasFiles(e)) return
          // Sem isso, a conversa por trás do painel pegaria o arquivo como anexo.
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          e.stopPropagation()
          void add([...e.dataTransfer.files].find((f) => f.type.startsWith('image/')) ?? e.dataTransfer.files[0])
        }}
      >
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
            <Scene theme={t} zoom={0.5} className="absolute inset-0" />
            <Tag picked={theme === t.id}>{t.name}</Tag>
          </button>
        ))}
        {images.map((i) => (
          <button
            key={i.id}
            type="button"
            aria-pressed={theme === i.id}
            aria-label={`Sua imagem ${i.name}`}
            onClick={() => pick(i.id)}
            className={cn(tileClass, 'bg-foreground/[0.06]')}
          >
            {i.style === 'photo' ? <Photo image={i} className="absolute inset-0" /> : <ImageScene image={i} zoom={0.5} className="absolute inset-0" />}
            <Tag picked={theme === i.id}>{i.name}</Tag>
          </button>
        ))}
        <button
          type="button"
          disabled={adding}
          onClick={() => input.current?.click()}
          className={cn(tileClass, 'flex flex-col items-center justify-center gap-1 bg-foreground/[0.06] text-muted-foreground hover:text-foreground')}
        >
          {adding ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
          <span className="text-[11px] font-medium">Sua imagem</span>
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void add(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>

      {(current || image) && (
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 px-1 pt-1">
          {image && (
            <>
              <span className="text-xs text-muted-foreground">Aparece como</span>
              <div className="flex items-center gap-1">
                <Segmented value={image.style} options={STYLES} onChange={(s) => setImageStyle(image.id, s)} className="flex-1" />
                <Button variant="ghost" size="icon-sm" onClick={remove} aria-label="Apagar esta imagem" title="Apagar esta imagem">
                  <Trash2 />
                </Button>
              </div>
            </>
          )}
          <span className="text-xs text-muted-foreground">Força</span>
          <Segmented
            value={intensity}
            options={INTENSITIES.map((i) => ({ key: i.key, label: i.label }))}
            onChange={(i) => setWallpaper({ intensity: i })}
          />
        </div>
      )}
    </Group>
  )
}
