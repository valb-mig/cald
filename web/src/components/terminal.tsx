import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useDarkMode } from '@/lib/hooks'
import { baseOf } from '@/lib/machines'

/** Fundo transparente (o da janela aparece) e o texto nos cinzas do app; as cores ANSI, as do xterm. */
const THEMES: Record<'dark' | 'light', ITheme> = {
  dark: { background: '#00000000', foreground: '#e5e5e5', cursor: '#e5e5e5', cursorAccent: '#171717', selectionBackground: '#ffffff33' },
  light: {
    background: '#00000000',
    foreground: '#262626',
    cursor: '#262626',
    cursorAccent: '#fafafa',
    selectionBackground: '#00000026',
    // No fundo claro, o amarelo e o branco do xterm somem: um tom mais escuro de cada.
    yellow: '#a16207',
    brightYellow: '#ca8a04',
    white: '#525252',
    brightWhite: '#404040',
  },
}

const socketUrl = (machine: string, cwd: string) => {
  const base = baseOf(machine)
  const origin = base ? base.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
  return `${origin}/ws/terminal?cwd=${encodeURIComponent(cwd)}`
}

type Status = 'connecting' | 'open' | 'exited' | 'failed'

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

  useEffect(() => {
    const el = box.current
    if (!el) return
    const t = new Terminal({
      allowTransparency: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: THEMES[document.documentElement.classList.contains('dark') ? 'dark' : 'light'],
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(el)
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
  }, [machine, cwd, generation])

  useEffect(() => {
    if (term.current) term.current.options.theme = THEMES[dark ? 'dark' : 'light']
  }, [dark])

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
      <div ref={box} className="cr-terminal absolute inset-0 pl-3" />
      {status === 'failed' && (
        <p className="absolute inset-x-0 top-0 bg-background p-4 text-sm text-muted-foreground">
          Não deu para conectar ao terminal do PC. Se esta função é nova no painel, reinicie o Claude Remote no PC.
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
