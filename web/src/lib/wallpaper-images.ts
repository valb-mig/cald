import { create } from 'zustand'
import { kvGet, kvSet } from './db'

/**
 * As imagens que você pôs como fundo da conversa. Ficam neste aparelho, como o resto do fundo, mas no
 * IndexedDB: uma foto passa fácil do limite do localStorage. Cada uma lembra como aparece: em
 * caracteres, pelo motor dos temas (ver components/wallpaper/image.ts), ou a própria foto.
 */
export type ImageId = `img:${string}`
export type ImageStyle = 'ascii' | 'photo'
export type WallpaperImage = { id: ImageId; name: string; blob: Blob; style: ImageStyle; url: string }
type Saved = Omit<WallpaperImage, 'url'>

const KEY = 'wallpaper-images'
// O lado maior da foto guardada: cobre uma tela 4K sem guardar os 12 MP da câmera.
const MAX_SIDE = 2560
const KEEP_ORIGINAL_BYTES = 1.5 * 1024 * 1024
const MAX_FILE_BYTES = 25 * 1024 * 1024

export const STYLES: { key: ImageStyle; label: string }[] = [
  { key: 'ascii', label: 'ASCII' },
  { key: 'photo', label: 'Foto' },
]

export const isImageId = (id: string): id is ImageId => id.startsWith('img:')

/** `loaded` só fica verdadeiro depois de ler o banco: antes disso, a imagem escolhida ainda pode estar lá. */
export const useWallpaperImages = create<{ loaded: boolean; items: WallpaperImage[] }>(() => ({ loaded: false, items: [] }))

const withUrl = (saved: Saved): WallpaperImage => ({ ...saved, url: URL.createObjectURL(saved.blob) })

kvGet<Saved[]>(KEY)
  .then((saved) => useWallpaperImages.setState({ loaded: true, items: (saved ?? []).map(withUrl) }))
  .catch(() => useWallpaperImages.setState({ loaded: true }))

function save(items: WallpaperImage[]): Promise<unknown> {
  useWallpaperImages.setState({ items })
  return kvSet(
    KEY,
    items.map(({ id, name, blob, style }): Saved => ({ id, name, blob, style })),
  )
}

const newId = (): ImageId =>
  `img:${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`

/**
 * A foto da câmera é reduzida antes de guardar; imagem pequena fica como está. GIF também: reduzir
 * tiraria a animação, que a foto mostra.
 */
async function shrink(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.size <= KEEP_ORIGINAL_BYTES) return file
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    // WebP guarda a transparência de um PNG; o JPEG a pintaria de preto.
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 })
  } finally {
    bitmap.close()
  }
}

/** Guarda a imagem e devolve o item novo, no fim da lista. Começa em ASCII, a cara dos temas. */
export async function addImage(file: File): Promise<WallpaperImage> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} não é uma imagem`)
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} passa de 25 MB`)
  let blob: Blob
  try {
    blob = await shrink(file)
  } catch {
    throw new Error(`Este navegador não abre ${file.name}`)
  }
  const item = withUrl({ id: newId(), name: file.name.replace(/\.[^.]+$/, '') || 'Imagem', blob, style: 'ascii' })
  await save([...useWallpaperImages.getState().items, item])
  return item
}

export function setImageStyle(id: ImageId, style: ImageStyle): void {
  void save(useWallpaperImages.getState().items.map((i) => (i.id === id ? { ...i, style } : i)))
}

export function removeImage(id: ImageId): void {
  const { items } = useWallpaperImages.getState()
  const gone = items.find((i) => i.id === id)
  if (!gone) return
  void save(items.filter((i) => i !== gone)).then(() => URL.revokeObjectURL(gone.url))
}
