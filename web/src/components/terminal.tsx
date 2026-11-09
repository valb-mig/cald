import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type IDecoration, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Loader2, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useDarkMode } from '@/lib/hooks'
import { useCodeFont } from '@/lib/code-font'
import { pinRejected, useLock } from '@/lib/lock'
import { baseOf } from '@/lib/machines'
import { withToken } from '@/lib/pin-tokens'
import { registerTerminal, setTermActivity, setTerminalHere, useTerminals, type TermActivity } from '@/lib/terminals'

/**
 * Fundo transparente (o da janela aparece) e o texto nos cinzas do app; as cores ANSI, as do terminal
 * do GitHub (github-dark-default e github-light-default), as mesmas do código no visualizador. Só os
 * cinzas (preto e branco do ANSI) saem do tema do GitHub, que puxa para o azul, e ficam os neutros do
 * app. A barra de rolagem é um traço discreto, como o resto.
 */
// O laranja do Claude, o mesmo do `›` do prompt do painel (ver server/src/shell/editr.zsh).
const CLAUDE = '#d97757'

const THEMES: Record<'dark' | 'light', ITheme> = {
  dark: {
    background: '#00000000',
    foreground: '#e5e5e5',
    cursor: CLAUDE,
    cursorAccent: '#171717',
    selectionBackground: '#ffffff33',
    selectionInactiveBackground: '#ffffff1a',
    scrollbarSliderBackground: '#ffffff1f',
    scrollbarSliderHoverBackground: '#ffffff38',
    scrollbarSliderActiveBackground: '#ffffff4d',
    black: '#525252',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#c4c4c4',
    brightBlack: '#737373',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#ffffff',
  },
  light: {
    background: '#00000000',
    foreground: '#262626',
    cursor: CLAUDE,
    cursorAccent: '#fafafa',
    selectionBackground: '#00000026',
    selectionInactiveBackground: '#00000014',
    scrollbarSliderBackground: '#0000001f',
    scrollbarSliderHoverBackground: '#00000033',
    scrollbarSliderActiveBackground: '#00000047',
    black: '#262626',
    red: '#cf222e',
    green: '#116329',
    yellow: '#4d2d00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#737373',
    brightBlack: '#525252',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#633c01',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#a3a3a3',
  },
}

// A mesma do código no resto do app (--font-mono em index.css); o tamanho segue o do código (Ctrl+= / Ctrl+−).
const FONT = 'Cascadia Code Variable'

/** A conexão com o shell da aba no PC: `id` acha o que já vive lá, e `since` diz até onde a tela já viu. */
const socketUrl = (machine: string, cwd: string, id: string, since: number) => {
  const base = baseOf(machine)
  const origin = base ? base.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
  return withToken(`${origin}/ws/terminal?cwd=${encodeURIComponent(cwd)}&id=${encodeURIComponent(id)}&since=${since}`)
}

/** O que o PC manda além da saída (que vem crua, binária). */
type ServerMsg = { t: 'attach'; fresh: boolean; from: number; replay: number } | { t: 'exit'; code?: number | null; error?: string }

type Status = 'connecting' | 'open' | 'reconnecting' | 'exited' | 'failed'

const note = (text: string) => `\r\n\x1b[2m${text}\x1b[0m\r\n`

/** Um bloco do terminal: um prompt e o comando que saiu dele (ver `watchBlocks`). Sem `ms` (NaN), o tempo não aparece. */
type Block = { state: 'idle' | 'running' | 'ok' | 'fail'; started: number; ms: number; code: number; deco?: IDecoration }

const seconds = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })
function took(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`
  if (ms < 60_000) return `${seconds.format(ms / 1000)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

/** O cabeçalho do bloco: a faixa (no CSS, `.cr-term-head`) e, à direita, o que o comando deu. */
function paintHead(node: HTMLElement, b: Block): void {
  node.classList.add('cr-term-head')
  node.dataset.state = b.state
  let status = node.firstElementChild as HTMLElement | null
  if (!status) {
    status = document.createElement('span')
    status.className = 'cr-term-status'
    node.append(status)
  }
  const time = Number.isFinite(b.ms) ? took(b.ms) : ''
  status.textContent =
    b.state === 'running'
      ? 'rodando'
      : b.state === 'ok'
        ? `✓ ${time}`.trim()
        : b.state === 'fail'
          ? [`✗ ${b.code}`, time].filter(Boolean).join(' · ')
          : ''
}

/**
 * Os blocos do terminal do painel, pelas marcas OSC 133 que o zsh dele escreve (ver
 * server/src/shell/editr.zsh): `A` abre o cabeçalho de um bloco, `C` diz que o comando rodou e
 * `D;n`, que saiu com `n`. Cada cabeçalho ganha uma faixa por baixo do texto, com o resultado e o tempo
 * do comando à direita. Sem as marcas (outro shell), o terminal fica como é. `onPrompt` avisa de cada
 * prompt novo, o sinal de que o shell está esperando um comando.
 */
function watchBlocks(t: Terminal, onState: (state: TermActivity) => void, replaying: () => boolean, onPrompt: () => void): void {
  let block: Block | null = null
  const repaint = (b: Block) => {
    if (b.deco?.element) paintHead(b.deco.element, b)
    onState(b.state)
  }
  t.parser.registerOscHandler(133, (data) => {
    const [kind, arg] = data.split(';')
    if (kind === 'A') {
      const marker = t.registerMarker(0)
      if (!marker) return true
      // O resultado do bloco anterior fica na bolinha da aba até o próximo comando rodar.
      const b: Block = { state: 'idle', started: 0, ms: 0, code: 0 }
      b.deco = t.registerDecoration({ marker, width: t.cols, layer: 'bottom' })
      b.deco?.onRender((node) => paintHead(node, b))
      block = b
      onPrompt()
    } else if (kind === 'C' && block) {
      block.state = 'running'
      // Na saída que o PC repassa ao reconectar, o relógio daqui não mede nada: o bloco fica sem tempo.
      block.started = replaying() ? NaN : performance.now()
      repaint(block)
    } else if (kind === 'D' && block && block.state === 'running') {
      block.code = Number(arg) || 0
      block.state = block.code === 0 ? 'ok' : 'fail'
      block.ms = performance.now() - block.started
      repaint(block)
    }
    return true
  })
}

/** A pasta em que o shell está, pela marca OSC 7 (`file://máquina/caminho`) que o zsh escreve a cada prompt. */
function watchFolder(t: Terminal, onFolder: (dir: string) => void): void {
  t.parser.registerOscHandler(7, (data) => {
    const path = data.replace(/^file:\/\/[^/]*/, '')
    if (!path.startsWith('/')) return true
    try {
      onFolder(decodeURIComponent(path))
    } catch {
      onFolder(path)
    }
    return true
  })
}

const MAC = /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * Copiar e colar como no terminal do VSCode: Ctrl+C copia o que está selecionado (sem seleção, segue
 * interrompendo o comando) e Ctrl+V cola; Ctrl+Shift+C/V e Ctrl/Shift+Insert também. No Mac, o ⌘ já
 * faz isso e o Ctrl fica com o terminal. Colar fica com o navegador: devolver `false` sem impedir a
 * tecla deixa o evento de colar chegar ao xterm, que cuida do "bracketed paste", sem pedir permissão
 * para ler a área de transferência.
 */
function handleClipboard(t: Terminal): void {
  t.attachCustomKeyEventHandler((e) => {
    if (MAC || e.altKey || e.metaKey) return true
    const key = e.key.toLowerCase()
    const copy = (e.ctrlKey && key === 'c' && (e.shiftKey || t.hasSelection())) || (e.ctrlKey && !e.shiftKey && key === 'insert')
    const paste = (e.ctrlKey && key === 'v') || (e.shiftKey && !e.ctrlKey && key === 'insert')
    if (copy) {
      if (e.type === 'keydown') {
        e.preventDefault()
        const text = t.getSelection()
        // Copiado, a seleção some: o próximo Ctrl+C volta a interromper.
        if (text) void navigator.clipboard?.writeText(text).then(() => t.clearSelection(), () => {})
      }
      return false
    }
    return !paste
  })
}

/**
 * Uma aba do terminal, no painel de baixo: o shell do PC na pasta dela, interativo (ver
 * server/src/terminal.ts). Fica montada enquanto a aba existe, mesmo escondida, e o shell vive no PC
 * além dela: se a conexão cai (o app travou, a rede piscou, o PC reiniciou o edit.r), volta sozinha pelo
 * id da aba e recebe só o que perdeu. Fechar a aba encerra o shell. `active` é quando ela está à vista
 * (aí ajusta o tamanho e pega o foco).
 */
export function TerminalView({ id, machine, cwd, active }: { id: string; machine: string; cwd: string; active: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const [status, setStatus] = useState<Status>('connecting')
  // Mudar a geração abre o terminal de novo (o "Abrir de novo", depois que o shell saiu): o PC abre
  // outro shell com o mesmo id.
  const [generation, setGeneration] = useState(0)
  const dark = useDarkMode()
  const fontSize = useCodeFont((s) => s.size)

  useEffect(() => {
    const el = box.current
    if (!el) return
    // Abre o terminal e a conexão com o shell do PC; devolve como fechar os dois.
    const start = (): (() => void) => {
      const t = new Terminal({
        allowTransparency: true,
        // As decorações (os cabeçalhos dos blocos, ver `watchBlocks`) ainda são API "proposta" no xterm.
        allowProposedApi: true,
        cursorBlink: true,
        cursorStyle: 'bar',
        cursorWidth: 2,
        cursorInactiveStyle: 'outline',
        fontFamily: `"${FONT}", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
        fontSize: useCodeFont.getState().size,
        // Mais aberta que o padrão, perto da do código no visualizador.
        lineHeight: 1.4,
        scrollback: 5000,
        // A roda do mouse desliza em vez de pular de três em três linhas.
        smoothScrollDuration: 120,
        theme: THEMES[document.documentElement.classList.contains('dark') ? 'dark' : 'light'],
      })
      const f = new FitAddon()
      t.loadAddon(f)
      t.open(el)
      // A saída de antes, que o PC repassa ao reconectar, está sendo escrita (ver `watchBlocks`).
      let replaying = false
      // Pronto para o que o app manda rodar aqui (os comandos salvos, ver lib/terminals.ts); `ready` liga.
      let unregister: (() => void) | undefined
      let readyTimer: ReturnType<typeof setTimeout> | undefined
      const ready = () => {
        clearTimeout(readyTimer)
        if (unregister || ws?.readyState !== WebSocket.OPEN) return
        unregister = registerTerminal(id, {
          paste: (text) => t.paste(text),
          send: (d) => send({ t: 'in', d }),
          focus: () => t.focus(),
        })
      }
      const unready = () => {
        clearTimeout(readyTimer)
        unregister?.()
        unregister = undefined
      }
      // Depois do resto do prompt, que liga o "bracketed paste" do zsh: colado antes, um comando de
      // várias linhas rodaria linha por linha.
      watchBlocks(t, (state) => setTermActivity(id, state), () => replaying, () => setTimeout(ready, 50))
      watchFolder(t, (dir) => setTerminalHere(id, dir))
      handleClipboard(t)
      term.current = t
      fit.current = f
      try {
        f.fit()
      } catch {
        // Escondido (tamanho zero): ajusta quando aparecer.
      }

      // Bytes da saída já na tela: ao reconectar, o PC manda só o que vem depois.
      let received = 0
      let ws: WebSocket | null = null
      // O shell saiu, a pasta foi recusada ou a aba fechou: não reconecta mais.
      let ended = false
      let tries = 0
      let retry: ReturnType<typeof setTimeout> | undefined
      // Bytes ainda por vir que são a saída de antes, repassada pelo PC.
      let pending = 0
      const send = (msg: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg))

      const connect = () => {
        clearTimeout(retry)
        if (ended || ws) return
        const socket = new WebSocket(socketUrl(machine, cwd, id, received))
        socket.binaryType = 'arraybuffer'
        ws = socket
        socket.onmessage = (e) => {
          if (typeof e.data !== 'string') {
            const bytes = new Uint8Array(e.data as ArrayBuffer)
            received += bytes.length
            if (!pending) return t.write(bytes)
            pending = Math.max(0, pending - bytes.length)
            replaying = true
            return t.write(bytes, () => (replaying = pending > 0))
          }
          const msg = JSON.parse(e.data) as ServerMsg
          if (msg.t === 'attach') {
            tries = 0
            // O PC não tinha mais este shell (o edit.r reiniciou): a tela antiga fica, e o novo segue embaixo.
            if (msg.fresh && received) t.write(note('O shell anterior foi encerrado no PC; este é um novo, na mesma pasta.'))
            // O que a tela já viu não está mais guardado lá: recomeça do que ficou.
            else if (!msg.fresh && msg.from !== received) t.reset()
            received = msg.from
            pending = msg.replay
            setStatus('open')
            send({ t: 'size', c: t.cols, r: t.rows })
            // O shell que já vivia está no prompt (ou no comando dele): recebe já. Um novo ainda está abrindo,
            // e o que chegasse agora sairia antes do prompt: espera o primeiro (sem as marcas, outro shell, um tempo).
            if (msg.fresh) readyTimer = setTimeout(ready, 3000)
            else ready()
          } else if (msg.t === 'exit') {
            ended = true
            unready()
            t.write(note(msg.error ? `Não deu para abrir o terminal: ${msg.error}` : 'O shell terminou.'))
            setStatus('exited')
          }
        }
        socket.onclose = (e) => {
          if (ws !== socket) return
          ws = null
          // Até reconectar, o que o app mandar para cá fica esperando.
          unready()
          if (ended) return
          // A pasta não é de um projeto conhecido: tentar de novo não muda nada.
          if (e.code === 1008) {
            ended = true
            return setStatus('failed')
          }
          setStatus('reconnecting')
          // Sem o token do PIN (o app travou): tenta destravar só esta máquina; senão, volta ao destravar.
          if (e.code === 4401) return void pinRejected(socket.url).then((ok) => ok && connect())
          retry = setTimeout(connect, Math.min(10_000, 500 * 2 ** tries++))
        }
      }
      connect()

      // Destravou, a rede voltou ou o app voltou para a frente: reconecta já, sem esperar a espera.
      const now = () => {
        tries = 0
        connect()
      }
      const unlocked = useLock.subscribe((s, prev) => s.round !== prev.round && now())
      const visible = () => document.visibilityState === 'visible' && now()
      addEventListener('online', now)
      document.addEventListener('visibilitychange', visible)

      const typing = t.onData((d) => send({ t: 'in', d }))
      const sizing = t.onResize(({ cols, rows }) => send({ t: 'size', c: cols, r: rows }))
      const resize = new ResizeObserver(() => {
        if (el.clientWidth && el.clientHeight) f.fit()
      })
      resize.observe(el)
      return () => {
        resize.disconnect()
        typing.dispose()
        sizing.dispose()
        unlocked()
        removeEventListener('online', now)
        document.removeEventListener('visibilitychange', visible)
        clearTimeout(retry)
        unready()
        // A aba foi fechada (não é só o app saindo da tela): o shell no PC acaba junto.
        if (!useTerminals.getState().tabs.some((tab) => tab.id === id)) send({ t: 'close' })
        ended = true
        ws?.close()
        t.dispose()
        term.current = null
      }
    }

    // O xterm mede a largura do caractere ao abrir e não refaz quando a fonte chega: com a de reserva
    // na medida, as colunas sairiam desencontradas. Por isso espera a Cascadia antes de abrir.
    let stop: (() => void) | undefined
    let cancelled = false
    void document.fonts
      .load(`${useCodeFont.getState().size}px "${FONT}"`)
      .catch(() => [])
      .then(() => {
        if (!cancelled) stop = start()
      })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [id, machine, cwd, generation])

  useEffect(() => {
    if (term.current) term.current.options.theme = THEMES[dark ? 'dark' : 'light']
  }, [dark])

  // A fonte do código mudou: o terminal acompanha e recalcula quantas colunas e linhas cabem.
  useEffect(() => {
    const t = term.current
    if (!t || t.options.fontSize === fontSize) return
    t.options.fontSize = fontSize
    try {
      fit.current?.fit()
    } catch {
      // escondido: ajusta quando aparecer
    }
  }, [fontSize])

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      try {
        fit.current?.fit()
      } catch {
        // ainda sem tamanho
      }
      term.current?.focus()
    })
  }, [active])

  return (
    <div className="relative min-h-0 flex-1">
      {/* A folga fica por fora da caixa do xterm: o ajuste de tamanho mede a caixa, e o recuo dentro dela vazaria.
          À esquerda, alinhado com o texto das abas do cabeçalho. */}
      <div className="absolute inset-0 pt-1 pr-1 pb-2 pl-[1.125rem]">
        <div ref={box} className="cr-terminal size-full" />
      </div>
      {status === 'reconnecting' && (
        <span className="cr-fade-in absolute top-1.5 right-3 flex items-center gap-1.5 rounded-full bg-background/80 px-2.5 py-1 text-[11px] text-muted-foreground shadow-xs backdrop-blur-sm">
          <Loader2 className="size-3 animate-spin" /> Reconectando ao PC…
        </span>
      )}
      {status === 'failed' && (
        <p className="cr-fade-in absolute inset-x-0 top-0 bg-background p-4 text-sm text-muted-foreground">
          Não deu para abrir o terminal nesta pasta. Feche a aba e abra outra a partir de um projeto.
        </p>
      )}
      {status === 'exited' && (
        <Button
          variant="secondary"
          size="sm"
          className="cr-fade-in absolute right-3 bottom-3"
          onClick={() => {
            setStatus('connecting')
            setGeneration((g) => g + 1)
          }}
        >
          <RotateCcw /> Abrir de novo
        </Button>
      )}
    </div>
  )
}
