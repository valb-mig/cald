import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type IDecoration, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useDarkMode } from '@/lib/hooks'
import { useCodeFont } from '@/lib/code-font'
import { baseOf } from '@/lib/machines'

/**
 * Fundo transparente (o da janela aparece) e o texto nos cinzas do app; as cores ANSI, as do terminal
 * do GitHub (github-dark-default e github-light-default), as mesmas do código no visualizador. Só os
 * cinzas (preto e branco do ANSI) saem do tema do GitHub, que puxa para o azul, e ficam os neutros do
 * app. A barra de rolagem é um traço discreto, como o resto.
 */
// O laranja do Claude, o mesmo do `›` do prompt do painel (ver server/src/shell/cald.zsh).
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

const socketUrl = (machine: string, cwd: string) => {
  const base = baseOf(machine)
  const origin = base ? base.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
  return `${origin}/ws/terminal?cwd=${encodeURIComponent(cwd)}`
}

type Status = 'connecting' | 'open' | 'exited' | 'failed'

/** Um bloco do terminal: um prompt e o comando que saiu dele (ver `watchBlocks`). */
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
  status.textContent =
    b.state === 'running' ? 'rodando' : b.state === 'ok' ? `✓ ${took(b.ms)}` : b.state === 'fail' ? `✗ ${b.code} · ${took(b.ms)}` : ''
}

/**
 * Os blocos do terminal do painel, pelas marcas OSC 133 que o zsh dele escreve (ver
 * server/src/shell/cald.zsh): `A` abre o cabeçalho de um bloco, `C` diz que o comando rodou e
 * `D;n`, que saiu com `n`. Cada cabeçalho ganha uma faixa por baixo do texto, com o resultado e o tempo
 * do comando à direita. Sem as marcas (outro shell), o terminal fica como é.
 */
function watchBlocks(t: Terminal): void {
  let block: Block | null = null
  const repaint = (b: Block) => b.deco?.element && paintHead(b.deco.element, b)
  t.parser.registerOscHandler(133, (data) => {
    const [kind, arg] = data.split(';')
    if (kind === 'A') {
      const marker = t.registerMarker(0)
      if (!marker) return true
      const b: Block = { state: 'idle', started: 0, ms: 0, code: 0 }
      b.deco = t.registerDecoration({ marker, width: t.cols, layer: 'bottom' })
      b.deco?.onRender((node) => paintHead(node, b))
      block = b
    } else if (kind === 'C' && block) {
      block.state = 'running'
      block.started = performance.now()
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

/**
 * O terminal do projeto, no painel de baixo: o shell do PC na pasta dele, interativo (ver
 * server/src/terminal.ts). Fica montado enquanto o painel existe, mesmo escondido, para o shell não
 * morrer ao trocar de aba ou de projeto; `active` é quando ele está à vista (aí ajusta o tamanho e
 * pega o foco).
 */
export function TerminalView({ machine, cwd, active }: { machine: string; cwd: string; active: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const [status, setStatus] = useState<Status>('connecting')
  // Mudar a geração abre um shell novo (o "Reiniciar", depois que o anterior saiu).
  const [generation, setGeneration] = useState(0)
  const dark = useDarkMode()
  const fontSize = useCodeFont((s) => s.size)

  useEffect(() => {
    const el = box.current
    if (!el) return
    // Abre o terminal e o shell do PC; devolve como fechar os dois.
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
        theme: THEMES[document.documentElement.classList.contains('dark') ? 'dark' : 'light'],
      })
      const f = new FitAddon()
      t.loadAddon(f)
      t.open(el)
      watchBlocks(t)
      term.current = t
      fit.current = f
      try {
        f.fit()
      } catch {
        // Escondido (tamanho zero): ajusta quando aparecer.
      }

      let opened = false
      const ws = new WebSocket(socketUrl(machine, cwd))
      ws.binaryType = 'arraybuffer'
      const send = (msg: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg))
      ws.onopen = () => {
        opened = true
        setStatus('open')
        send({ t: 'size', c: t.cols, r: t.rows })
      }
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return t.write(new Uint8Array(e.data as ArrayBuffer))
        const msg = JSON.parse(e.data) as { t?: string; error?: string }
        if (msg.t === 'exit') {
          t.write(`\r\n\x1b[2m${msg.error ? `Não deu para abrir o terminal: ${msg.error}` : 'O shell terminou.'}\x1b[0m\r\n`)
          setStatus('exited')
        }
      }
      ws.onclose = () => setStatus((s) => (s === 'exited' ? s : opened ? 'exited' : 'failed'))
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
        ws.close()
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
  }, [machine, cwd, generation])

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
      {status === 'failed' && (
        <p className="absolute inset-x-0 top-0 bg-background p-4 text-sm text-muted-foreground">
          Não deu para conectar ao terminal do PC. Se esta função é nova no painel, reinicie o cald no PC.
        </p>
      )}
      {(status === 'exited' || status === 'failed') && (
        <Button
          variant="secondary"
          size="sm"
          className="absolute right-3 bottom-3"
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
