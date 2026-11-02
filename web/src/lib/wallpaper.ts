import { useLocation } from 'wouter'
import { create } from 'zustand'
import { onWorkbench } from './workbench'

/**
 * Fundo animado da conversa: qual tema e com que força ele aparece. É escolha deste aparelho (como
 * os sons), então fica no localStorage e não passa pelo servidor — o celular pode ter o aquário e o
 * PC ficar limpo.
 */
// Os temas que existem; o salvo de um que saiu do app (ver `load`) não vale mais.
const THEME_IDS = [
  'none',
  'aquarium',
  'jellyfish',
  'fireflies',
  'codigo',
  'aurora',
  'galaxia',
  'luar',
  'chuva',
  'sakura',
  'nuvens',
  'lagoa',
  'carpas',
  'barquinhos',
  'som',
] as const
export type ThemeId = (typeof THEME_IDS)[number]
export type Intensity = 'subtle' | 'medium' | 'strong'

export type WallpaperPrefs = { theme: ThemeId; intensity: Intensity }

const KEY = 'cr:wallpaper'
// Começa desligado: o fundo é escolha de quem usa, não surpresa na primeira vez que abre a conversa.
const DEFAULTS: WallpaperPrefs = { theme: 'none', intensity: 'medium' }

/** Opacidade da camada inteira (degradê e caracteres); é o que separa "enfeite" de "atrapalha ler". */
export const OPACITY: Record<Intensity, number> = { subtle: 0.3, medium: 0.55, strong: 0.85 }

/**
 * Véu por trás da coluna de mensagens, na cor do fundo da página: ele puxa a cena de volta para o
 * fundo do app e devolve contraste ao texto. Acompanha a intensidade, senão no "sutil" escureceria
 * mais do que a própria cena aparece. As classes ficam escritas por extenso porque o Tailwind lê o
 * fonte para saber quais gerar.
 */
export const SCRIM: Record<Intensity, string> = {
  subtle: 'bg-background/45',
  medium: 'bg-background/65',
  strong: 'bg-background/80',
}

export const INTENSITIES: { key: Intensity; label: string }[] = [
  { key: 'subtle', label: 'Sutil' },
  { key: 'medium', label: 'Médio' },
  { key: 'strong', label: 'Forte' },
]

function load(): WallpaperPrefs {
  try {
    const saved = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<WallpaperPrefs>) }
    // Tema que saiu do app: volta ao sem fundo, senão o vidro ficava ligado sem nada atrás.
    return (THEME_IDS as readonly string[]).includes(saved.theme) ? saved : { ...saved, theme: 'none' }
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

/** O véu da coluna de mensagens agora, ou vazio quando não há cena atrás. */
export function useScrim(): string {
  const intensity = useWallpaper((s) => s.intensity)
  return useGlass() ? SCRIM[intensity] : ''
}

export function setWallpaper(next: Partial<WallpaperPrefs>): void {
  useWallpaper.setState(next)
  try {
    localStorage.setItem(KEY, JSON.stringify(useWallpaper.getState()))
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
}
