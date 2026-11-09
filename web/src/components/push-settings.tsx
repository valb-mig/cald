import { Bell, BellOff, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Group, SettingRow } from '@/components/settings-ui'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { errorMessage } from '@/lib/api'
import { disablePush, enablePush, loadPrefs, pushStatus, savePrefs, testPush, type PushStatus } from '@/lib/push'
import type { PushPrefs } from '@/lib/types'

const OPTIONS: { key: keyof PushPrefs; label: string; hint: string }[] = [
  { key: 'done', label: 'Quando terminar', hint: 'Com a última resposta do Claude.' },
  { key: 'pc', label: 'Sessões abertas no PC', hint: 'Do terminal ou do VSCode, depois de algo que levou mais de 1 min.' },
]

/** Liga as notificações deste aparelho e escolhe o que avisa. */
export function PushSettings() {
  const [status, setStatus] = useState<PushStatus | null>(null)
  const [prefs, setPrefs] = useState(loadPrefs)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const check = () => void pushStatus().then(setStatus)
    check()
    // Volta das configurações do Android, onde a permissão pode ter sido liberada.
    const onVisible = () => document.visibilityState === 'visible' && check()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (key: keyof PushPrefs, on: boolean) =>
    run(async () => {
      const next = { ...prefs, [key]: on }
      await savePrefs(next)
      setPrefs(next)
    })

  return (
    <Group
      title="Notificações"
      note="Perguntas, pedidos de aprovação e erros avisam sempre. Os avisos passam criptografados pelo push do Google (da Apple, no iPhone)."
    >
      {status === null && <SettingRow label="Verificando…" />}
      {status === 'unsupported' && (
        <SettingRow
          label="Indisponível neste navegador"
          hint="Instale o app pelo Chrome (no iPhone, pela Tela de Início do Safari) e abra por ele."
        />
      )}
      {status === 'denied' && (
        <SettingRow label="Bloqueadas" hint="Libere nas configurações do aparelho (Apps → edit.r → Notificações) e volte aqui." />
      )}
      {status === 'off' && (
        <SettingRow label="Avisos neste aparelho" hint="Mesmo com o app fechado; tocar no aviso abre a conversa.">
          <Button size="sm" disabled={busy} onClick={() => run(async () => setStatus(await enablePush()))}>
            <Bell /> Ativar
          </Button>
        </SettingRow>
      )}
      {status === 'on' && (
        <>
          {OPTIONS.map((o) => (
            <SettingRow key={o.key} label={o.label} hint={o.hint} htmlFor={`push-${o.key}`}>
              <Switch id={`push-${o.key}`} checked={prefs[o.key]} disabled={busy} onCheckedChange={(on) => toggle(o.key, on)} />
            </SettingRow>
          ))}
          <div className="flex gap-1 px-2 pt-1 pb-1.5">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await testPush()
                  toast.success('Aviso enviado. Deve chegar em alguns segundos.')
                })
              }
            >
              <Send /> Enviar teste
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await disablePush()
                  setStatus('off')
                })
              }
            >
              <BellOff /> Desativar
            </Button>
          </div>
        </>
      )}
    </Group>
  )
}
