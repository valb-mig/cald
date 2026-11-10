import { Group, SettingRow } from '@/components/settings-ui'
import { Switch } from '@/components/ui/switch'
import { METERS, setMeterEnabled, setMetersShown, useMeters } from '@/lib/meters'

/** Quais medidores a barra lateral mostra, e se estão à vista (o ícone da barra também alterna). */
export function MetersSettings() {
  const { shown, enabled } = useMeters()
  return (
    <Group title="Medidores da barra">
      <SettingRow label="Mostrar na barra" htmlFor="meters-shown">
        <Switch id="meters-shown" checked={shown} onCheckedChange={setMetersShown} />
      </SettingRow>
      {METERS.map((m) => (
        <SettingRow key={m.key} label={m.label} hint={m.hint} htmlFor={`meter-${m.key}`}>
          <Switch id={`meter-${m.key}`} checked={enabled[m.key]} onCheckedChange={(on) => setMeterEnabled(m.key, on)} />
        </SettingRow>
      ))}
    </Group>
  )
}
