import { create } from 'zustand'

/**
 * Medidores da barra lateral (Hoje, CPU, memória e limites do Claude, ver components/sidebar-rail.tsx):
 * quais aparecem e se estão à vista. Começam escondidos; o ícone da barra mostra e esconde. Fica salvo
 * neste aparelho, como os sons.
 */
export const METERS = [
  { key: 'today', label: 'Hoje', hint: 'Tempo codando, do WakaTime.' },
  { key: 'cpu', label: 'CPU', hint: 'Uso do processador.' },
  { key: 'mem', label: 'Memória', hint: 'Uso da memória.' },
  { key: 'five', label: '5 h', hint: 'Limite do Claude em 5 horas.' },
  { key: 'week', label: 'Semana', hint: 'Limite do Claude na semana.' },
] as const
export type MeterKey = (typeof METERS)[number]['key']

type MeterPrefs = { shown: boolean; enabled: Record<MeterKey, boolean> }

const KEY = 'cr:meters'
const DEFAULTS: MeterPrefs = { shown: false, enabled: { today: true, cpu: true, mem: true, five: true, week: true } }

function load(): MeterPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<MeterPrefs>
    return { shown: saved.shown === true, enabled: { ...DEFAULTS.enabled, ...saved.enabled } }
  } catch {
    return DEFAULTS
  }
}

export const useMeters = create<MeterPrefs>(load)

function save(next: Partial<MeterPrefs>): void {
  useMeters.setState(next)
  try {
    const { shown, enabled } = useMeters.getState()
    localStorage.setItem(KEY, JSON.stringify({ shown, enabled }))
  } catch {
    // localStorage indisponível (modo privado): vale só até fechar o app.
  }
}

export const setMetersShown = (shown: boolean) => save({ shown })
export const setMeterEnabled = (key: MeterKey, on: boolean) => save({ enabled: { ...useMeters.getState().enabled, [key]: on } })
