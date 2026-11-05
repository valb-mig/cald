import type { CSSProperties } from 'react'
import { useLocation } from 'wouter'
import { create } from 'zustand'
import { themeOf } from '@/components/wallpaper/themes'
import { isImageId, useWallpaperImages, type ImageId } from './wallpaper-images'
import { onWorkbench } from './workbench'

/**
 * Fundo animado da conversa: qual tema e com que força ele aparece. É escolha deste aparelho (como
 * os sons), então fica no localStorage e não passa pelo servidor — o celular pode ter o aquário e o
 * PC ficar limpo. Além dos temas, o fundo pode ser uma imagem sua (ver wallpaper-images.ts).
 */
// Os temas que existem; o salvo de um que saiu do app (ver `load`) não vale mais.
const THEME_IDS = ['none', 'ondas'] as const
export type ThemeId = (typeof THEME_IDS)[number] | ImageId
export type Intensity = 'subtle' | 'medium' | 'strong'

/** `dim`: quanto a janela escurece a cena atrás do texto, de 0 a 1 (ver `useScrim` e veil.tsx). */
export type WallpaperPrefs = { theme: ThemeId; intensity: Intensity; dim: number }

const KEY = 'cr:wallpaper'
// Começa desligado: o fundo é escolha de quem usa, não surpresa na primeira vez que abre a conversa.
const DEFAULTS: WallpaperPrefs = { theme: 'none', intensity: 'medium', dim: 0.65 }

/** Opacidade da camada inteira (degradê e caracteres); é o que separa "enfeite" de "atrapalha ler". */
export const OPACITY: Record<Intensity, number> = { subtle: 0.3, medium: 0.55, strong: 0.85 }

/** Até onde dá para escurecer: acima disso a cena some de vez, e aí era melhor o sem fundo. */
export const MAX_DIM = 0.9

// Antes de dar para escolher, o escurecido seguia a força da cena; quem já usava fica com o que tinha.
const LEGACY_DIM: Record<Intensity, number> = { subtle: 0.45, medium: 0.65, strong: 0.8 }

export const INTENSITIES: { key: Intensity; label: string }[] = [
  { key: 'subtle', label: 'Sutil' },
  { key: 'medium', label: 'Médio' },
  { key: 'strong', label: 'Forte' },
]

function load(): WallpaperPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<WallpaperPrefs>
    const saved = { ...DEFAULTS, ...stored }
    saved.dim = typeof stored.dim === 'number' ? Math.min(MAX_DIM, Math.max(0, stored.dim)) : (LEGACY_DIM[saved.intensity] ?? DEFAULTS.dim)
    // Tema que saiu do app: volta ao sem fundo, senão o vidro ficava ligado sem nada atrás. A imagem
    // só se confere quando o banco abrir (ver abaixo).
    return (THEME_IDS as readonly string[]).includes(saved.theme) || isImageId(saved.theme) ? saved : { ...saved, theme: 'none' }
  } catch {
    return DEFAULTS
  }
}

/** O fundo deste aparelho; vale para todas as conversas e fica salvo. */
export const useWallpaper = create<WallpaperPrefs>(load)

/**
 * Se as superfícies do chat (a barra de mensagem, o leitor, o cais dos pedidos) devem virar vidro.
 * Só na tela das conversas (no PC, a das abas: ver `onWorkbench`), que é a única com fundo animado atrás,
 * e só com um tema escolhido: desfocar
 * uma cor chapada custaria GPU para não mudar nada na tela.
 */
export function useGlass(): boolean {
  const theme = useWallpaper((s) => s.theme)
  const [location] = useLocation()
  return theme !== 'none' && onWorkbench(location)
}

/** O fundo de um bloco numa aba sobre a cena (o hub, o workspace): o vidro da barra do chat; sem cena, um tom acima. */
export function useSurface(): string {
  return useGlass() ? 'bg-background/70 backdrop-blur-md' : 'bg-foreground/[0.04]'
}

/** Se a cena escolhida pede o escurecido: a foto pede, como uma cena cheia; a imagem em ASCII dispensa, como as Ondas. */
export function useVeiled(): boolean {
  const theme = useWallpaper((s) => s.theme)
  const photo = useWallpaperImages((s) => s.items.some((i) => i.id === theme && i.style === 'photo'))
  return photo || (themeOf(theme)?.veil ?? false)
}

/** Quanto escurecer a cena atrás do texto agora (0 a 1), ou null quando não há cena atrás ou ela dispensa. */
export function useScrim(): number | null {
  const dim = useWallpaper((s) => s.dim)
  const veiled = useVeiled()
  return useGlass() && veiled ? dim : null
}

/**
 * O escurecido da cena atrás do texto, com a força de `useScrim` (ver Veil). No claro, tem a cor do fundo
 * da página; no escuro, é preto, porque o cinza da janela deixava a foto lavada atrás do texto em vez de
 * escurecer. A força vai numa variável, já que é um número qualquer.
 */
export function veil(dim: number): { className: string; style: CSSProperties } {
  return {
    className: 'bg-background/(--veil) dark:bg-black/(--veil)',
    style: { '--veil': `${Math.round(dim * 100)}%` } as CSSProperties,
  }
}

export function setWallpaper(next: Partial<WallpaperPrefs>): void {
  useWallpaper.setState(next)
  try {
    localStorage.setItem(KEY, JSON.stringify(useWallpaper.getState()))
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
}

// A imagem escolhida saiu (apagada aqui ou com os dados do site): volta ao sem fundo, como um tema que
// saiu do app.
useWallpaperImages.subscribe(({ loaded, items }) => {
  const { theme } = useWallpaper.getState()
  if (loaded && isImageId(theme) && !items.some((i) => i.id === theme)) setWallpaper({ theme: 'none' })
})
