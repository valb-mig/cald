import { ImagePlus } from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Soltar arquivos num pedaço da tela (vários de uma vez, como as imagens de uma pasta). Só reage a
 * arquivos de fora: arrastar uma aba ou uma conversa não acende nada. `over` diz quando mostrar o aviso.
 */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false)
  // Entrar num filho dispara "saiu" do pai: conta as entradas, e só apaga quando sai de vez.
  const depth = useRef(0)
  const files = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')
  return {
    over,
    bind: {
      onDragEnter: (e: React.DragEvent) => {
        if (!files(e)) return
        e.preventDefault()
        depth.current++
        setOver(true)
      },
      onDragOver: (e: React.DragEvent) => {
        if (!files(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!files(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (!depth.current) setOver(false)
      },
      onDrop: (e: React.DragEvent) => {
        if (!files(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        const list = [...e.dataTransfer.files]
        if (list.length) onFiles(list)
      },
    },
  }
}

/** O aviso por cima de onde vai cair: a borda tracejada e o que acontece ao soltar. */
export function DropOverlay({ show, label = 'Solte para anexar', className }: { show: boolean; label?: string; className?: string }) {
  if (!show) return null
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-2 z-40 flex animate-in flex-col items-center justify-center gap-2 rounded-pane border-2 border-dashed border-foreground/30 bg-background/80 text-sm text-muted-foreground backdrop-blur-sm duration-150 fade-in-0',
        className,
      )}
    >
      <ImagePlus className="size-6" />
      {label}
    </div>
  )
}
