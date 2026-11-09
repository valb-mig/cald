import { Bell, BellOff, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Group, SettingRow } from '@/components/settings-ui'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { errorMessage } from '@/lib/api'
import { desktop, type DesktopNotifications } from '@/lib/desktop'
import { disablePush, enablePush, loadPrefs, pushStatus, savePrefs, testPush, type PushStatus } from '@/lib/push'
import type { PushPrefs } from '@/lib/types'

const OPTIONS: { key: keyof PushPrefs; label: string; hint: string }[] = [
  { key: 'done', label: 'Quando terminar', hint: 'Com a última resposta do Claude.' },
  { key: 'pc', label: 'Sessões abertas no PC', hint: 'Do terminal ou do VSCode, depois de algo que levou mais de 1 min.' },
]

/** Liga as notificações deste aparelho e escolhe o que avisa. */
export function PushSettings() {
  return desktop ? <DesktopPushSettings bridge={desktop} /> : <WebPushSettings />
}

/**
 * No app do PC: avisos do sistema, que o próprio app mostra (ver desktop/src/notifications.ts), com
 * a janela fechada também, enquanto ele estiver na bandeja.
 */
function DesktopPushSettings({ bridge }: { bridge: NonNullable<typeof desktop> }) {
  const [state, setState] = useState<DesktopNotifications | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void bridge.notifications.get().then(setState)
  }, [bridge])

  async function save(next: DesktopNotifications) {
    setBusy(true)
    try {
      setState(await bridge.notifications.set(next))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Group
      title="Notificações"
      note="Perguntas, pedidos de aprovação e erros avisam sempre. Aqui no PC, os avisos são do sistema e chegam com a janela fechada, enquanto o edit.r estiver na bandeja."
    >
      {state === null && <SettingRow label="Verificando…" />}
      {state && (
        <>
          <SettingRow label="Avisos neste PC" hint="Com a janela do edit.r na frente, o aviso não aparece." htmlFor="push-enabled">
            <Switch id="push-enabled" checked={state.enabled} disabled={busy} onCheckedChange={(on) => void save({ ...state, enabled: on })} />
          </SettingRow>
          {state.enabled &&
            OPTIONS.map((o) => (
              <SettingRow key={o.key} label={o.label} hint={o.hint} htmlFor={`push-${o.key}`}>
                <Switch id={`push-${o.key}`} checked={state[o.key]} disabled={busy} onCheckedChange={(on) => void save({ ...state, [o.key]: on })} />
              </SettingRow>
            ))}
          {state.enabled && (
            <div className="flex gap-1 px-2 pt-1 pb-1.5">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void bridge.notifications.test().catch((err: unknown) => toast.error(errorMessage(err)))}>
                <Send /> Enviar teste
              </Button>
            </div>
          )}
        </>
      )}
    </Group>
  )
}

function WebPushSettings() {
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
