import { useMemo } from 'react'
import { encode } from 'uqr'
import { cn } from '@/lib/utils'

/**
 * O QR de um endereço, para a câmera do celular abrir. Sempre escuro sobre branco, nos dois temas:
 * nem toda câmera lê o QR invertido. Carregado à parte (ver access-settings.tsx), só quando aparece.
 */
export default function AccessQr({ value, className }: { value: string; className?: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: 2 })
    // Uma tira por sequência de módulos escuros de cada linha: o caminho fica bem menor que um quadrado por módulo.
    let d = ''
    qr.data.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (!row[x]) continue
        const start = x
        while (x + 1 < row.length && row[x + 1]) x++
        d += `M${start} ${y}h${x - start + 1}v1h-${x - start + 1}z`
      }
    })
    return { size: qr.size, path: d }
  }, [value])
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`QR de ${value}`}
      className={cn('rounded-lg bg-white text-black', className)}
    >
      <path d={path} fill="currentColor" />
    </svg>
  )
}
