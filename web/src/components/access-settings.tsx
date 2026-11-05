import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Copy,
  ExternalLink,
  KeyRound,
  LockOpen,
  Monitor,
  Power,
  PowerOff,
  Share2,
  ShieldAlert,
  ShieldX,
  Smartphone,
  TriangleAlert,
  Unplug,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Tag } from '@/components/claude/bits'
import { Group, SettingRow } from '@/components/settings-ui'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { loadAccess, setAccessLink, useAccess } from '@/lib/access'
import { api, errorMessage } from '@/lib/api'
import { setComputerSection } from '@/lib/computer'
import { messageTime, relativeTime, shortTime } from '@/lib/format'
import { useWide } from '@/lib/hooks'
import { useLock } from '@/lib/lock'
import { HOME } from '@/lib/machines'
import { pushStatus } from '@/lib/push'
import type { AccessBlocked, AccessConnection, AccessEvent, AccessInfo, LinkCheck } from '@/lib/types'
import { cn } from '@/lib/utils'

// O QR só aparece no PC, com o link no ar: a biblioteca dele chega só então.
const AccessQr = lazy(() => import('@/components/access-qr'))

const PLAY_STORE = 'https://play.google.com/store/apps/details?id=com.tailscale.ipn'
const APP_STORE = 'https://apps.apple.com/app/tailscale/id1470499037'
const TAILSCALE_DNS = 'https://login.tailscale.com/admin/dns'
const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download'

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']
const IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent)
const ANDROID = /Android/i.test(navigator.userAgent)

/** Os eventos que pedem atenção: alguém de fora tentando entrar. */
const ALERTS = new Set<AccessEvent['kind']>(['denied_login', 'pin_wrong', 'pin_blocked'])
/** Quantos eventos aparecem antes do "Ver mais". */
const FIRST_EVENTS = 10

/** O endereço sem o `https://` nem a barra do fim, para caber na linha. */
const bare = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

/**
 * A seção Acesso do painel Computador: o link remoto (o `tailscale serve`) com o QR para o celular e o
 * que falta no PC para ele funcionar, o passo a passo no celular, quem está com o app aberto agora
 * (com Desconectar, que bloqueia até liberar), os bloqueados e o histórico de acessos.
 */
export function AccessSettings({ machine }: { machine: string }) {
  const { info, error } = useAccess(machine)
  const wide = useWide()
  useTick(30_000)

  // Na volta de outra aba (o painel do Tailscale, onde se liga o HTTPS), a checagem é refeita.
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && void loadAccess(machine, true)
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [machine])

  // O Tailscale não avisa quando o celular entra na tailnet: enquanto falta algo, a checagem repete sozinha.
  const pending = info ? problemsOf(info.link).length > 0 || !phoneJoined(info) || !phoneOpened(info) : false
  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => void loadAccess(machine, true), 15_000)
    return () => clearInterval(timer)
  }, [pending, machine])

  if (!info) return error ? <p className="px-1 py-2 text-sm text-red-600 dark:text-red-400">{error}</p> : <AccessSkeleton />
  const self = info.connected.find((c) => c.self)
  // Neste celular, o QR não serve: o link vai por copiar ou compartilhar.
  const phone = self ? self.mobile : !wide
  // A página não veio do próprio PC (localhost), e sim pelo link: desligar derruba ela também. Vale
  // até no PC, aberto pelo endereço da tailnet; e sempre para outra máquina, que só se alcança pelo link dela.
  const remote = machine !== HOME || !LOCAL_HOSTS.includes(location.hostname)
  return (
    <>
      <LinkGroup machine={machine} link={info.link} phone={phone} remote={remote} />
      <PhoneSteps info={info} phone={phone} />
      <NowGroup machine={machine} connected={info.connected} />
      <BlockedGroup machine={machine} blocked={info.blocked} />
      <RecentGroup events={info.events} />
    </>
  )
}

/** Redesenha a cada `ms`, para o "há 5 min" andar. */
function useTick(ms: number) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), ms)
    return () => clearInterval(timer)
  }, [ms])
}

function AccessSkeleton() {
  return (
    <>
      <Skeleton className="h-36 rounded-xl" />
      <Skeleton className="h-11 rounded-xl" />
      <Skeleton className="h-28 rounded-xl" />
    </>
  )
}

type Problem = { key: string; label: string; hint: React.ReactNode; action?: React.ReactNode }

/** O que falta no PC para o link funcionar, cada um com o que fazer. */
function problemsOf(link: LinkCheck): Problem[] {
  if (link.tailscale === 'missing') {
    return [{ key: 'tailscale', label: 'Tailscale fora do PC', hint: 'Instale e entre com a sua conta.', action: <ExternalButton href={TAILSCALE_DOWNLOAD}>Baixar</ExternalButton> }]
  }
  if (link.tailscale === 'stopped') {
    return [{ key: 'tailscale', label: 'Tailscale parado', hint: <>Rode <code>tailscale up</code> no PC.</> }]
  }
  const off = [!link.magicDns && 'MagicDNS', !link.https && 'HTTPS'].filter((x) => x !== false)
  if (!off.length) return []
  return [
    {
      key: 'dns',
      label: `${off.join(' e ')} ${off.length > 1 ? 'desligados' : 'desligado'}`,
      hint: 'No painel DNS do Tailscale.',
      action: <ExternalButton href={TAILSCALE_DNS}>Abrir</ExternalButton>,
    },
  ]
}

function ExternalButton({ href, size = 'sm', children }: { href: string; size?: 'sm' | 'xs'; children: React.ReactNode }) {
  return (
    <Button variant="ghost" size={size} asChild>
      <a href={href} target="_blank" rel="noreferrer">
        {children}
        <ExternalLink />
      </a>
    </Button>
  )
}

/** O link remoto: no ar (com o QR no PC) ou desligado, o que falta no PC e o liga e desliga. */
function LinkGroup({ machine, link, phone, remote }: { machine: string; link: LinkCheck; phone: boolean; remote: boolean }) {
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const on = link.published
  const problems = problemsOf(link)

  async function set(next: boolean) {
    setBusy(true)
    try {
      const res = await api.setLink(machine, next)
      setAccessLink(machine, res.link)
      toast.success(next ? 'Link no ar' : remote ? 'Link desligado. Este aparelho vai sair.' : 'Link desligado')
    } catch (err) {
      toast.error(errorMessage(err), { duration: 10_000 })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Group>
      <div className="flex items-start gap-4 p-3">
        {on && link.url && !phone && (
          <Suspense fallback={<Skeleton className="size-28 shrink-0 rounded-lg" />}>
            <AccessQr value={link.url} className="size-28 shrink-0" />
          </Suspense>
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex min-h-7 items-center gap-2">
            <span className={cn('size-2 shrink-0 rounded-full', on ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
            <span className="flex-1 text-sm font-medium">{on ? 'No ar' : 'Desligado'}</span>
            {on ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm(true)}>
                <PowerOff /> Desligar
              </Button>
            ) : (
              <Button size="sm" disabled={busy || link.tailscale !== 'running'} onClick={() => void set(true)}>
                <Power /> Ligar
              </Button>
            )}
          </div>
          {on ? (
            link.url && <Address url={link.url} shortcut={link.shortcut} phone={phone} />
          ) : (
            <p className="text-xs text-muted-foreground">Só o PC abre o app.</p>
          )}
        </div>
      </div>
      {problems.map((p) => (
        <SettingRow
          key={p.key}
          label={
            <span className="flex items-center gap-2">
              <TriangleAlert className="size-3.5 shrink-0 text-amber-500" />
              {p.label}
            </span>
          }
          hint={p.hint}
        >
          {p.action}
        </SettingRow>
      ))}

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desligar o link?</AlertDialogTitle>
            <AlertDialogDescription>
              {remote ? (
                <>
                  Os aparelhos da tailnet saem agora, este também. Para religar, abra <code>localhost:7337</code> no PC ou rode{' '}
                  <code>cald -link on</code>.
                </>
              ) : (
                'Os aparelhos da tailnet saem agora. Religue aqui quando quiser.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void set(false)}>
              Desligar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Group>
  )
}

/** O endereço que o celular abre: no PC, ao lado do QR; no celular, com copiar e compartilhar. */
function Address({ url, shortcut, phone }: { url: string; shortcut?: string; phone: boolean }) {
  // Sem HTTPS (o atalho em http), o navegador não dá a área de transferência.
  function copy() {
    if (!navigator.clipboard) {
      toast.error('Este navegador não deixa copiar daqui.')
      return
    }
    navigator.clipboard.writeText(url).then(
      () => toast.success('Link copiado'),
      () => toast.error('Não deu para copiar.'),
    )
  }
  const share = () => navigator.share({ title: 'cald', url }).catch(() => {})
  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate font-mono text-[12.5px]" title={url}>
          {bare(url)}
        </span>
        {!phone && (
          <Button variant="ghost" size="icon-xs" title="Copiar o link" aria-label="Copiar o link" onClick={copy}>
            <Copy />
          </Button>
        )}
      </div>
      {!phone && <p className="text-xs text-muted-foreground">Aponte a câmera do celular.</p>}
      {shortcut && (
        <p className="text-xs text-muted-foreground">
          Ou digite <code>{bare(shortcut)}/</code> no navegador.
        </p>
      )}
      {phone && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Button variant="secondary" size="sm" onClick={copy}>
            <Copy /> Copiar
          </Button>
          {'share' in navigator && (
            <Button variant="secondary" size="sm" onClick={() => void share()}>
              <Share2 /> Compartilhar
            </Button>
          )}
        </div>
      )}
    </>
  )
}

const phoneJoined = (info: AccessInfo) => info.link.phones.length > 0

/** Um celular que já abriu o app: conectado agora, ou que conectou antes. */
function phoneOpened(info: AccessInfo): { name?: string } | undefined {
  return info.connected.find((c) => c.mobile) ?? info.events.find((e) => (e.kind === 'connect' || e.kind === 'new_device') && e.mobile)
}

/** "Pixel 8 · online", "Pixel 8 · online +1". */
function phonesSummary(phones: LinkCheck['phones']): string {
  const [first] = phones
  if (!first) return ''
  return `${first.name} · ${first.online ? 'online' : 'offline'}${phones.length > 1 ? ` +${phones.length - 1}` : ''}`
}

const isInstalled = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

/** Os avisos estão ligados neste aparelho; só pergunta quando `active`. */
function usePushOn(active: boolean): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!active) return
    let live = true
    void pushStatus().then((s) => live && setOn(s === 'on'))
    return () => {
      live = false
    }
  }, [active])
  return on
}

/**
 * O passo a passo no celular, marcado sozinho pela checagem do PC (e, no próprio celular, pelo que
 * ele sabe de si). Recolhido quando já há um celular na tailnet que abriu o link.
 */
function PhoneSteps({ info, phone }: { info: AccessInfo; phone: boolean }) {
  const { link } = info
  const joined = phoneJoined(info)
  const opened = phoneOpened(info)
  const [open, setOpen] = useState(!(joined && opened))
  const installed = phone && isInstalled()
  const pushOn = usePushOn(phone)

  const stores =
    phone && IOS ? (
      <ExternalButton href={APP_STORE} size="xs">App Store</ExternalButton>
    ) : phone && ANDROID ? (
      <ExternalButton href={PLAY_STORE} size="xs">Play Store</ExternalButton>
    ) : (
      <>
        <ExternalButton href={PLAY_STORE} size="xs">Android</ExternalButton>
        <ExternalButton href={APP_STORE} size="xs">iPhone</ExternalButton>
      </>
    )
  const install = IOS
    ? 'Safari: Compartilhar → Adicionar à Tela de Início.'
    : ANDROID
      ? 'Chrome: ⋮ → Instalar app.'
      : 'Android: Chrome ⋮ → Instalar app. iPhone: Safari → Compartilhar → Tela de Início.'

  return (
    <Group>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button type="button" className="group flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-foreground/5">
            <Smartphone className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="text-sm">Conectar um celular</div>
              {/* Aberto, os passos já dizem isso. */}
              {!open && <div className="truncate text-xs text-muted-foreground">{joined ? phonesSummary(link.phones) : '4 passos'}</div>}
            </div>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Step n={1} done={joined} label="Tailscale no celular" hint={joined ? phonesSummary(link.phones) : link.login ? <>Entre com {link.login}.</> : 'Entre com a mesma conta do PC.'}>
            {!joined && stores}
          </Step>
          <Step
            n={2}
            done={Boolean(opened)}
            label="Abrir o link"
            hint={opened ? opened.name : link.published ? 'Pelo QR ou digitando o endereço.' : 'Depois de ligar o link.'}
          />
          <Step n={3} done={installed} label="Instalar o app" hint={installed ? 'Instalado.' : install} />
          <Step n={4} done={pushOn} label="Ativar avisos" hint={pushOn ? 'Ligados.' : phone ? 'Perguntas e aprovações chegam aqui.' : 'No celular, em Computador → Avisos.'}>
            {phone && !pushOn && (
              <Button variant="ghost" size="xs" onClick={() => setComputerSection('alerts')}>
                Avisos <ChevronRight />
              </Button>
            )}
          </Step>
        </CollapsibleContent>
      </Collapsible>
    </Group>
  )
}

function Step({ n, done, label, hint, children }: { n: number; done: boolean; label: string; hint?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2">
      {done ? (
        <CircleCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Feito" />
      ) : (
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[10px] font-medium text-muted-foreground tabular-nums">{n}</span>
      )}
      <div className="min-w-0 flex-1">
        <div className={cn('text-sm', done && 'text-muted-foreground')}>{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
    </div>
  )
}

function DeviceIcon({ mobile, className }: { mobile?: boolean; className?: string }) {
  return mobile ? <Smartphone className={className} /> : <Monitor className={className} />
}

async function unblock(machine: string, key: string, name: string) {
  try {
    await api.unblockDevice(machine, key)
    toast.success(`${name} liberado`)
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

/** Quem está com o app aberto agora: este aparelho primeiro, depois do mais novo para o mais antigo. */
function NowGroup({ machine, connected }: { machine: string; connected: AccessConnection[] }) {
  const pin = useLock((s) => s.enabled)
  const [target, setTarget] = useState<AccessConnection>()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const list = [...connected].sort((a, b) => Number(b.self) - Number(a.self) || b.since - a.since)

  async function kick(c: AccessConnection) {
    setBusy(c.key)
    try {
      await api.kickDevice(machine, c.key)
      toast.success(`${c.name} desconectado`, { action: { label: 'Desfazer', onClick: () => void unblock(machine, c.key, c.name) } })
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Group
      title="Agora"
      note={
        machine === HOME &&
        !pin && (
          <>
            Sem PIN, um aparelho da sua conta entra direto.{' '}
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setComputerSection('about')}>
              Ver em Sobre
            </button>
          </>
        )
      }
    >
      {list.length === 0 && <SettingRow label="Ninguém agora" />}
      {list.map((c) => (
        <div key={c.key} className="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2">
          <DeviceIcon mobile={c.mobile} className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm">{c.name}</span>
              {c.self && <Tag>este aparelho</Tag>}
            </div>
            {(c.client || c.tabs > 1) && (
              <div className="truncate text-xs text-muted-foreground">{[c.client, c.tabs > 1 && `${c.tabs} abas`].filter(Boolean).join(' · ')}</div>
            )}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums" title={`Desde ${messageTime(c.since)}`}>
            {shortTime(c.since)}
          </span>
          {!c.self && !c.local && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy === c.key}
              title="Desconectar"
              aria-label={`Desconectar ${c.name}`}
              onClick={() => {
                setTarget(c)
                setConfirm(true)
              }}
            >
              <Unplug />
              <span className="max-sm:hidden">Desconectar</span>
            </Button>
          )}
        </div>
      ))}

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">Desconectar {target?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Ele sai agora e fica bloqueado até você liberar aqui.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => target && void kick(target)}>
              Desconectar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Group>
  )
}

/** "há 2 dias", ou "em 03/11" quando já faz mais de uma semana. */
const when = (ms: number) => {
  const text = relativeTime(ms)
  return /^\d/.test(text) ? `em ${text}` : text
}

function BlockedGroup({ machine, blocked }: { machine: string; blocked: AccessBlocked[] }) {
  const [busy, setBusy] = useState<string | null>(null)
  if (!blocked.length) return null
  return (
    <Group title="Bloqueados">
      {blocked.map((b) => (
        <div key={b.key} className="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2">
          <DeviceIcon mobile={b.mobile} className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{b.name}</div>
            <div className="text-xs text-muted-foreground">Desconectado {when(b.at)}</div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy === b.key}
            onClick={() => {
              setBusy(b.key)
              void unblock(machine, b.key, b.name).finally(() => setBusy(null))
            }}
          >
            <LockOpen /> Liberar
          </Button>
        </div>
      ))}
    </Group>
  )
}

function eventText(e: AccessEvent): string {
  const who = e.name ?? 'Um aparelho'
  const by = e.name ? ` · ${e.name}` : ''
  const times = e.count && e.count > 1 ? ` ×${e.count}` : ''
  switch (e.kind) {
    case 'new_device':
      return `${who} entrou pela primeira vez`
    case 'connect':
      return `${who} conectou${times}`
    case 'denied_login':
      return `Conta ${e.login ?? 'desconhecida'} barrada${times}${by}`
    case 'pin_wrong':
      return `PIN errado${times}${by}`
    case 'pin_blocked':
      return `PIN bloqueado após erros${by}`
    case 'kicked':
      return `${who} desconectado por você`
    case 'unblocked':
      return `${who} liberado`
    case 'link_off':
      return `Link desligado${by}`
    case 'link_on':
      return `Link ligado${by}`
    default:
      return String(e.kind)
  }
}

function EventIcon({ event: e, className }: { event: AccessEvent; className?: string }) {
  switch (e.kind) {
    case 'denied_login':
      return <ShieldX className={className} />
    case 'pin_wrong':
      return <KeyRound className={className} />
    case 'pin_blocked':
      return <ShieldAlert className={className} />
    case 'kicked':
      return <Unplug className={className} />
    case 'unblocked':
      return <LockOpen className={className} />
    case 'link_off':
      return <PowerOff className={className} />
    case 'link_on':
      return <Power className={className} />
    default:
      return <DeviceIcon mobile={e.mobile} className={className} />
  }
}

/** O histórico, do mais novo para o mais antigo; só as tentativas barradas ganham cor. */
function RecentGroup({ events }: { events: AccessEvent[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? events : events.slice(0, FIRST_EVENTS)
  return (
    <Group title="Recentes">
      {events.length === 0 && <p className="px-3 py-2.5 text-sm text-muted-foreground">Nenhum acesso ainda.</p>}
      {shown.map((e, i) => {
        const text = eventText(e)
        const alert = ALERTS.has(e.kind)
        return (
          <div key={`${e.at}-${e.kind}-${i}`} className="flex items-center gap-3 rounded-lg px-3 py-2">
            <EventIcon event={e} className={cn('size-3.5 shrink-0', alert ? 'text-red-500' : 'text-muted-foreground')} />
            <span className={cn('min-w-0 flex-1 truncate text-sm', e.kind === 'new_device' && 'font-medium')} title={text}>
              {text}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums" title={messageTime(e.at)}>
              {shortTime(e.at)}
            </span>
          </div>
        )
      })}
      {!all && events.length > FIRST_EVENTS && (
        <Button variant="ghost" size="sm" className="m-1 text-muted-foreground" onClick={() => setAll(true)}>
          Ver mais {events.length - FIRST_EVENTS}
        </Button>
      )}
    </Group>
  )
}
