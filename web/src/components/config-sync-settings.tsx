import { ChevronRight, CloudDownload, CloudUpload, ExternalLink, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Group, SettingRow } from '@/components/settings-ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { api, errorMessage, isOutdatedServer, OUTDATED_SERVER } from '@/lib/api'
import { applyAppearance, loadKinds, readAppearance, saveKinds, SKIP_LABEL, SYNC_GROUPS, SYNC_KINDS } from '@/lib/config-sync'
import { relativeTime } from '@/lib/format'
import type { ConfigSyncKind, ConfigSyncReport, ConfigSyncStatus } from '@/lib/types'

type Busy = 'connect' | 'create' | 'disconnect' | 'push' | 'pull' | null
type Direction = ConfigSyncReport['direction']

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * A seção Sincronizar do painel Computador: a configuração da máquina num repositório privado seu no
 * GitHub, para levar a outra (ver lib/config-sync.ts). Liga o repositório, criando se preciso; escolhe
 * o que vai junto; e envia ou traz, sempre passando antes por uma prévia do que muda.
 */
export function ConfigSyncSettings({ machine }: { machine: string }) {
  const [status, setStatus] = useState<ConfigSyncStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [repo, setRepo] = useState('cald-config')
  const [kinds, setKinds] = useState(loadKinds)
  const [busy, setBusy] = useState<Busy>(null)
  const [preview, setPreview] = useState<ConfigSyncReport | null>(null)
  const [result, setResult] = useState<ConfigSyncReport | null>(null)

  useEffect(() => {
    api.configSync(machine).then(setStatus, (err) => setError(isOutdatedServer(err) ? OUTDATED_SERVER : errorMessage(err)))
  }, [machine])

  async function run(what: Busy, action: () => Promise<void>) {
    setBusy(what)
    try {
      await action()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const connect = (create: boolean) =>
    run(create ? 'create' : 'connect', async () => {
      setStatus(await api.connectConfigRepo(machine, repo.trim(), create))
      setPreview(null)
      setResult(null)
    })

  const disconnect = () =>
    run('disconnect', async () => {
      setStatus(await api.disconnectConfigRepo(machine))
      setPreview(null)
      setResult(null)
    })

  const toggle = (key: ConfigSyncKind, on: boolean) => {
    const next = new Set(kinds)
    if (on) next.add(key)
    else next.delete(key)
    setKinds(next)
    saveKinds(next)
    // A prévia era das categorias de antes.
    setPreview(null)
  }

  const body = (direction: Direction, dry: boolean) => ({
    direction,
    kinds: SYNC_KINDS.map((k) => k.key).filter((k) => kinds.has(k)),
    appearance: kinds.has('appearance') ? readAppearance() : undefined,
    dry,
  })

  const look = (direction: Direction) =>
    run(direction, async () => {
      setResult(null)
      setPreview(await api.runConfigSync(machine, body(direction, true)))
    })

  const confirm = (direction: Direction) =>
    run(direction, async () => {
      const done = await api.runConfigSync(machine, body(direction, false))
      setPreview(null)
      setResult(done)
      setStatus(await api.configSync(machine))
    })

  if (!status) {
    return (
      <Group>
        <SettingRow label={error ? `Indisponível: ${error}` : 'Lendo…'} />
      </Group>
    )
  }

  if (!status.repo) {
    return (
      <Group
        title="Repositório"
        note="Um repositório privado no seu GitHub guarda a configuração desta máquina; na outra, ligue o mesmo e traga. Usa o login do gh do PC."
      >
        <form
          className="flex gap-1.5 p-2 max-sm:flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void connect(true)
          }}
        >
          <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="cald-config ou dono/nome" aria-label="Repositório" className="flex-1" />
          <div className="flex gap-1.5">
            <Button type="submit" disabled={busy !== null || !repo.trim()}>
              {busy === 'create' && <Loader2 className="animate-spin" />}
              Criar privado
            </Button>
            <Button type="button" variant="ghost" disabled={busy !== null || !repo.trim()} onClick={() => void connect(false)}>
              {busy === 'connect' && <Loader2 className="animate-spin" />}
              Usar existente
            </Button>
          </div>
        </form>
      </Group>
    )
  }

  const syncing = busy === 'push' || busy === 'pull'
  const remote = status.remote
  const hint = [
    remote ? `último envio ${remote.machine === status.machine ? 'daqui' : `de ${remote.machine}`} ${relativeTime(remote.at)}` : 'nada enviado ainda',
    status.lastPull && `trazido ${relativeTime(status.lastPull)}`,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <Group title="Repositório">
        <SettingRow
          label={
            status.url ? (
              <a href={status.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 break-all hover:underline">
                {status.repo}
                <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
              </a>
            ) : (
              <span className="break-all">{status.repo}</span>
            )
          }
          hint={hint.charAt(0).toUpperCase() + hint.slice(1)}
        >
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void disconnect()}>
            Desligar
          </Button>
        </SettingRow>
        <div className="grid grid-cols-2 gap-1.5 p-2 pt-1">
          <Button disabled={busy !== null || !kinds.size} onClick={() => void look('pull')}>
            {busy === 'pull' && !preview ? <Loader2 className="animate-spin" /> : <CloudDownload />}
            Trazer para cá
          </Button>
          <Button variant="secondary" disabled={busy !== null || !kinds.size} onClick={() => void look('push')}>
            {busy === 'push' && !preview ? <Loader2 className="animate-spin" /> : <CloudUpload />}
            Enviar daqui
          </Button>
        </div>
      </Group>

      {preview && <Report report={preview} busy={syncing} onConfirm={() => void confirm(preview.direction)} onCancel={() => setPreview(null)} />}
      {result && <Report report={result} />}

      {SYNC_GROUPS.map((g) => (
        <Group key={g.title} title={g.title}>
          {g.kinds.map((k) => (
            <SettingRow key={k.key} label={k.label} hint={k.hint} htmlFor={`sync-${k.key}`}>
              <Switch id={`sync-${k.key}`} checked={kinds.has(k.key)} disabled={syncing} onCheckedChange={(on) => toggle(k.key, on)} />
            </SettingRow>
          ))}
        </Group>
      ))}
    </>
  )
}

/** O que um envio ou um "Trazer" fez, por categoria; na prévia, com o botão que faz de verdade. */
function Report({ report, busy, onConfirm, onCancel }: { report: ConfigSyncReport; busy?: boolean; onConfirm?: () => void; onCancel?: () => void }) {
  const push = report.direction === 'push'
  const changed = report.kinds.filter((k) => k.total > 0)
  const total = changed.reduce((n, k) => n + k.total, 0)
  const skipped = report.kinds.flatMap((k) => k.skipped)
  const title = report.dry ? (push ? 'Vai para o repositório' : 'Vem para cá') : push ? 'Enviado' : 'Trazido'

  const notes = [
    push && skipped.some((s) => s.reason === 'newer-there') && 'Há itens mais novos no repositório: traga antes, senão eles ficam de fora do envio.',
    report.missingProjects.length > 0 &&
      `Projetos que não existem aqui: ${report.missingProjects.join(', ')}. Clone-os (o cald acha o projeto pelo remoto do git) e traga de novo.`,
    !report.dry && report.commit && `Commit ${report.commit}.`,
    !report.dry && !push && total > 0 && 'O que foi trocado aqui ficou copiado antes, em ~/.local/share/cald/config-backup.',
  ].filter(Boolean)

  return (
    <Group title={title} note={notes.length ? notes.join(' ') : undefined}>
      {changed.length ? (
        changed.map((k) => <KindLine key={k.kind} kind={k} />)
      ) : (
        <SettingRow label={report.dry ? 'Nada novo' : 'Nada mudou'} hint="O que está aqui e o que está no repositório são iguais." />
      )}
      {skipped.length > 0 && (
        <Lines
          label={plural(skipped.length, 'item ficou como estava', 'itens ficaram como estavam')}
          items={skipped.map((s) => `${s.label}: ${SKIP_LABEL[s.reason]}`)}
        />
      )}
      {report.dry && (
        <div className="flex gap-1.5 p-2 pt-1">
          <Button disabled={busy || !total} onClick={onConfirm}>
            {busy && <Loader2 className="animate-spin" />}
            {push ? 'Enviar' : 'Trazer'} {plural(total, 'item', 'itens')}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      )}
      {!report.dry && report.appearance && (
        <SettingRow label="Aparência de lá" hint="Vale neste aparelho depois de recarregar o app.">
          <Button size="sm" onClick={() => applyAppearance(report.appearance!)}>
            Aplicar e recarregar
          </Button>
        </SettingRow>
      )}
    </Group>
  )
}

function KindLine({ kind }: { kind: ConfigSyncReport['kinds'][number] }) {
  const info = SYNC_KINDS.find((k) => k.key === kind.kind)
  const updated = kind.total - kind.totalAdded
  const counts = [kind.totalAdded > 0 && plural(kind.totalAdded, 'novo', 'novos'), updated > 0 && plural(updated, 'atualizado', 'atualizados')].filter(Boolean).join(' · ')
  const listed = [...kind.added.map((l) => `+ ${l}`), ...kind.updated.map((l) => `~ ${l}`)]
  return <Lines label={info?.label ?? kind.kind} hint={counts} items={listed} more={kind.total - listed.length} />
}

/** Uma linha que abre a lista dos itens. */
function Lines({ label, hint, items, more = 0 }: { label: string; hint?: string; items: string[]; more?: number }) {
  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-foreground/5 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">
          <div className="text-sm">{label}</div>
          {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      <ul className="space-y-0.5 px-3 pb-2 text-xs text-muted-foreground">
        {items.map((item, i) => (
          <li key={i} className="break-words">
            {item}
          </li>
        ))}
        {more > 0 && <li>e mais {more}</li>}
      </ul>
    </details>
  )
}
