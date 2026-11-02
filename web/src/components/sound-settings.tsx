import { Play } from 'lucide-react'
import { Group, SettingRow } from '@/components/settings-ui'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { playSound, setSound, useSounds, type Sound } from '@/lib/sounds'

const OPTIONS: { key: Sound; label: string; hint: string }[] = [
  { key: 'attention', label: 'Pergunta ou aprovação', hint: 'Duas notas subindo.' },
  { key: 'done', label: 'Quando terminar', hint: 'Três notas descendo.' },
]

/** Liga e desliga os sons do app e deixa ouvir cada um antes. */
export function SoundSettings() {
  const prefs = useSounds()
  return (
    <Group title="Sons" note="Com o app aberto. Em segundo plano, quem avisa é a notificação.">
      {OPTIONS.map((o) => (
        <SettingRow key={o.key} label={o.label} hint={o.hint} htmlFor={`sound-${o.key}`}>
          <Button variant="ghost" size="icon-sm" onClick={() => playSound(o.key, true)} aria-label={`Ouvir: ${o.label}`}>
            <Play className="fill-current" />
          </Button>
          <Switch id={`sound-${o.key}`} checked={prefs[o.key]} onCheckedChange={(on) => setSound(o.key, on)} />
        </SettingRow>
      ))}
    </Group>
  )
}
