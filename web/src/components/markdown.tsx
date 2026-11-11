import { Check, Copy, ImageIcon } from 'lucide-react'
import { memo, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { ImageThumb } from '@/components/image-viewer'
import { OptionPick } from '@/components/option-pick'
import { ReadingLine } from '@/components/reading-line'
import { Button } from '@/components/ui/button'
import { findColors } from '@/lib/colors'
import { commandOf } from '@/lib/commands'
import { chose, rehypeOptions } from '@/lib/options'
import { rehypeOutline } from '@/lib/outline'
import { cn } from '@/lib/utils'

const COLLAPSE_AFTER_LINES = 14

export function CopyButton({ text, className, label = 'Copiar' }: { text: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={className}
      title={label}
      aria-label={label}
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  )
}

/**
 * Copiar ao lado de um link ou de um comando no meio do texto: discreto e sempre à vista, porque no
 * celular não há "passar o mouse". A área de toque passa do ícone (`after:`) sem empurrar o texto.
 */
function InlineCopy({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const Icon = copied ? Check : Copy
  return (
    // O navegador quebra a linha antes de qualquer botão (nem o "word joiner" segura), e o ícone caía
    // sozinho na linha de baixo. Num span comum, colado no texto, ele vai junto com a última letra.
    <span className="relative ml-1 pl-[1em] select-none">
      {'\u2060'}
      <button
        type="button"
        title={label}
        aria-label={label}
        onClick={() =>
          navigator.clipboard.writeText(text).then(
            () => setCopied(true),
            () => toast.error('Não deu para copiar: o navegador não liberou a área de transferência.'),
          )
        }
        className="absolute inset-0 flex items-center justify-center rounded-sm text-muted-foreground/60 transition-colors after:absolute after:-inset-1.5 hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Icon className={cn('size-[1em] shrink-0', copied && 'text-emerald-600 dark:text-emerald-400')} />
      </button>
    </span>
  )
}

/** O quadradinho com a cor, antes do valor, como no VSCode. A borda fina o separa do fundo (branco no claro, preto no escuro). */
function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="mr-[0.3em] inline-block size-[0.8em] rounded-[3px] align-[-0.05em] inset-ring inset-ring-foreground/25"
      style={{ background: color }}
    />
  )
}

/** O texto com o quadradinho antes de cada cor escrita nele (ver lib/colors.ts). */
function withSwatches(text: string): ReactNode {
  const colors = findColors(text)
  if (!colors.length) return text
  const out: ReactNode[] = []
  let at = 0
  for (const c of colors) {
    out.push(
      text.slice(at, c.start),
      <span key={c.start} className="whitespace-nowrap">
        <Swatch color={c.value} />
        {text.slice(c.start, c.end)}
      </span>,
    )
    at = c.end
  }
  out.push(text.slice(at))
  return out
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const lines = code.split('\n').length
  const long = lines > COLLAPSE_AFTER_LINES
  const [expanded, setExpanded] = useState(!long)
  return (
    <div className="my-2 overflow-hidden rounded-md border bg-muted/40">
      <div className="flex items-center justify-between border-b px-2 py-1 text-xs text-muted-foreground">
        <span className="font-mono">
          {lang || 'código'} · {lines} {lines === 1 ? 'linha' : 'linhas'}
        </span>
        <div className="flex items-center gap-1">
          {long && (
            <Button variant="ghost" size="xs" onClick={() => setExpanded((e) => !e)}>
              {expanded ? 'Recolher' : 'Expandir'}
            </Button>
          )}
          <CopyButton text={code} />
        </div>
      </div>
      <pre className={cn('overflow-x-auto p-3 font-mono text-xs leading-relaxed', !expanded && 'max-h-48 overflow-y-hidden')}>
        <code>{withSwatches(code)}</code>
      </pre>
    </div>
  )
}

// ---- leitura em voz alta (ver lib/speech.ts): como a letra no Spotify ----

type HastElement = NonNullable<ExtraProps['node']>
type HastChild = HastElement['children'][number]
type Reading = { reading: boolean; current: boolean }

const BLOCKS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'table', 'blockquote'])

const spans = (node: HastElement, line: number) => {
  const p = node.position
  return Boolean(p && p.start.line <= line && line <= p.end.line)
}

// Um bloco de dentro (o parágrafo de um item, uma sublista) tem a linha: o destaque fica com ele.
const inner = (node: HastElement, line: number): boolean =>
  node.children.some((c) => c.type === 'element' && ((BLOCKS.has(c.tagName) && spans(c, line)) || inner(c, line)))

/** Se o bloco tem a frase sendo lida; quando passa a ter, rola a conversa até ele. */
function useReading<T extends HTMLElement>(node?: HastElement): [RefObject<T | null>, Reading] {
  const line = useContext(ReadingLine)
  const ref = useRef<T>(null)
  const current = line !== null && node !== undefined && spans(node, line) && !inner(node, line)
  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [current])
  return [ref, { reading: line !== null, current }]
}

// Texto: o bloco atual na cor normal e o resto esmaecido. Cor (e não opacidade) porque blocos se
// aninham: o item atual de uma sublista volta à cor normal dentro de um item esmaecido.
const tone = ({ reading, current }: Reading) =>
  reading && cn('transition-colors duration-300', current ? 'text-foreground' : 'text-muted-foreground')
// Código e tabela têm cores próprias: esmaecem inteiros.
const dim = ({ reading, current }: Reading) => reading && cn('transition-opacity duration-300', !current && 'opacity-40')

function Paragraph({ node, children }: ComponentProps<'p'> & ExtraProps) {
  const [ref, r] = useReading<HTMLParagraphElement>(node)
  return (
    <p ref={ref} className={cn('my-2 leading-relaxed first:mt-0 last:mb-0', tone(r))}>
      {children}
    </p>
  )
}

function ListItem({ node, className, ...props }: ComponentProps<'li'> & ExtraProps) {
  const [ref, r] = useReading<HTMLLIElement>(node)
  return <li ref={ref} className={cn(className, tone(r))} {...props} />
}

function Heading({ node, children }: ComponentProps<'h1'> & ExtraProps) {
  const [ref, r] = useReading<HTMLHeadingElement>(node)
  return (
    <h3 ref={ref} className={cn('mt-4 mb-2 text-base font-semibold', tone(r))}>
      {children}
    </h3>
  )
}

function Subheading({ node, children }: ComponentProps<'h3'> & ExtraProps) {
  const [ref, r] = useReading<HTMLHeadingElement>(node)
  return (
    <h4 ref={ref} className={cn('mt-3 mb-1.5 font-semibold', tone(r))}>
      {children}
    </h4>
  )
}

function Pre({ node, children }: ComponentProps<'pre'> & ExtraProps) {
  const [ref, r] = useReading<HTMLDivElement>(node)
  return (
    <div ref={ref} className={cn(dim(r))}>
      {children}
    </div>
  )
}

/**
 * Lista de "tópicos e pontos" (ver lib/outline.ts): cada tópico é um título com o número num selo (um
 * ponto, na lista sem número), o resto da linha em cinza, e os pontos embaixo, recuados até o título
 * e presos a ele por um fio.
 */
function OutlineTitle({ mark, children }: { mark: string; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-2 font-semibold">
      <span
        aria-hidden={!mark}
        className={cn(
          'flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-[11px] font-medium text-muted-foreground tabular-nums',
          mark && 'bg-foreground/[0.06]',
        )}
      >
        {mark || <span className="size-1.5 rounded-full bg-muted-foreground/50" />}
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  )
}

/**
 * Uma opção da resposta (ver lib/options.ts): o número numa bolinha, como a escolha de uma pergunta do
 * Claude, o título e a descrição em cinza. Na resposta que você ainda não respondeu, tocar na opção a
 * escreve na caixa de mensagem; respondida, a que você escolheu fica acesa.
 */
function OptionItem({ node, children }: ComponentProps<'li'> & ExtraProps) {
  const [ref, r] = useReading<HTMLLIElement>(node)
  const options = useContext(OptionPick)
  const mark = String(node?.properties.dataOption ?? '')
  const text = String(node?.properties.dataPick ?? '')
  const pick = options?.pick
  const chosen = Boolean(options && (options.answer !== undefined ? chose(options.answer, mark, text) : options.picked === text))
  const bullet = cn(
    'flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium tabular-nums transition-colors',
    chosen ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/35 text-muted-foreground',
  )
  // Na lista sem número, a bolinha vazia, como a de uma escolha; escolhida, com o ponto dentro.
  const inner = mark || (chosen && <span className="size-1.5 rounded-full bg-primary-foreground" />)
  return (
    <li
      ref={ref}
      onClick={
        pick &&
        ((e) => {
          // Um link, um copiar ou um texto sendo selecionado dentro da opção não a escolhem.
          if ((e.target as Element).closest('a, button') || getSelection()?.toString()) return
          pick(text)
        })
      }
      className={cn(
        'flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors',
        pick && 'cursor-pointer hover:bg-foreground/[0.04]',
        chosen && 'bg-primary/[0.07] hover:bg-primary/10',
        tone(r),
      )}
    >
      {pick ? (
        // Pelo teclado, a escolha é a bolinha; com o dedo ou o mouse, a linha toda.
        <button
          type="button"
          title={text}
          aria-label={`Responder: ${text}`}
          onClick={() => pick(text)}
          className={cn(bullet, 'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none')}
        >
          {inner}
        </button>
      ) : (
        <span aria-hidden className={bullet}>
          {inner}
        </span>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  )
}

/**
 * O desenho de uma lista: as opções de uma resposta num bloco, uma linha por opção; um sumário de
 * seções; ou a lista comum, com o número e o ponto em cinza, para o texto ficar na frente, e a
 * sublista colada no item de cima.
 */
const listClass = (node: HastElement | undefined, numbered: boolean) =>
  node?.properties.dataOptions !== undefined
    ? 'my-3 list-none space-y-0.5 rounded-xl bg-foreground/[0.04] p-1'
    : node?.properties.dataOutline !== undefined
      ? 'my-3 list-none space-y-3'
      : cn(
          'my-2 space-y-1 pl-5 [li>&]:my-1',
          numbered ? 'list-decimal marker:text-muted-foreground' : 'list-disc marker:text-muted-foreground/70',
        )

function Table({ node, children }: ComponentProps<'table'> & ExtraProps) {
  const [ref, r] = useReading<HTMLDivElement>(node)
  return (
    <div ref={ref} className={cn('my-2 overflow-x-auto rounded-md border', dim(r))}>
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  )
}

/**
 * Plugin do rehype: no texto corrido (fora de código e de link), cada cor vira um `span` com ela, que o
 * componente `span` desenha com o quadradinho. O código põe os dele sozinho (ver `withSwatches`).
 */
function rehypeColors() {
  const walk = (node: { children: HastChild[] }) => {
    node.children = node.children.flatMap((child): HastChild[] => {
      if (child.type === 'element') {
        if (!['code', 'pre', 'a'].includes(child.tagName)) walk(child)
        return [child]
      }
      const colors = child.type === 'text' ? findColors(child.value, true) : []
      if (child.type !== 'text' || !colors.length) return [child]
      const { value } = child
      const out: HastChild[] = []
      let at = 0
      for (const c of colors) {
        if (c.start > at) out.push({ type: 'text', value: value.slice(at, c.start) })
        out.push({ type: 'element', tagName: 'span', properties: { dataColor: c.value }, children: [{ type: 'text', value: value.slice(c.start, c.end) }] })
        at = c.end
      }
      if (at < value.length) out.push({ type: 'text', value: value.slice(at) })
      return out
    })
  }
  return walk
}

/** Código inline (com as cores) ou em bloco; no chat, o inline que é um comando ganha o copiar. */
const code =
  (chat: boolean): Components['code'] =>
  ({ className, children }) => {
    const text = String(children).replace(/\n$/, '')
    const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1]
    if (lang || text.includes('\n')) return <CodeBlock code={text} lang={lang} />
    const command = chat && commandOf(text)
    return (
      <>
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] break-words">{withSwatches(text)}</code>
        {command && <InlineCopy text={command} label="Copiar o comando" />}
      </>
    )
  }

/** Link em outra aba; no chat, com o copiar do endereço ao lado. */
const link =
  (chat: boolean): Components['a'] =>
  ({ children, href }) => {
    const copy = chat && href && /^https?:\/\//.test(href)
    // A URL escrita por extenso quebra em qualquer letra; link com texto quebra nos espaços, como o resto.
    // Com o copiar, o `break-all` vai em volta do link e do ícone: só no link, o Firefox quebra a linha
    // entre os dois.
    const a = (
      <a href={href} target="_blank" rel="noreferrer" className={cn('text-primary underline underline-offset-2', !copy && 'break-all')}>
        {children}
      </a>
    )
    if (!copy) return a
    return (
      <span className={cn(typeof children === 'string' && !/\s/.test(children) && 'break-all')}>
        {a}
        <InlineCopy text={href} label="Copiar o link" />
      </span>
    )
  }

const components: Components = {
  pre: Pre,
  code: code(false),
  span: ({ node, children }) => {
    if (node?.properties.dataOutlineNote !== undefined) return <span className="ml-1.5 font-normal text-muted-foreground">{children}</span>
    const color = node?.properties.dataColor
    if (typeof color !== 'string') return <span>{children}</span>
    return (
      <span className="whitespace-nowrap">
        <Swatch color={color} />
        {children}
      </span>
    )
  },
  p: Paragraph,
  li: (props) => (props.node?.properties.dataOption !== undefined ? <OptionItem {...props} /> : <ListItem {...props} />),
  ul: ({ node, children }) => <ul className={listClass(node, false)}>{children}</ul>,
  ol: ({ node, children, start }) => (
    <ol start={start} className={listClass(node, true)}>
      {children}
    </ol>
  ),
  div: ({ node, children }) => {
    const mark = node?.properties.dataOutlineTitle
    if (typeof mark === 'string') return <OutlineTitle mark={mark}>{children}</OutlineTitle>
    if (node?.properties.dataOptionTitle !== undefined)
      return (
        <div className="font-medium">
          {children}
          {node.properties.dataRecommended !== undefined && (
            <span className="ml-2 inline-block rounded-full bg-emerald-500/15 px-1.5 py-px align-[1px] text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
              Recomendado
            </span>
          )}
        </div>
      )
    const body = node?.properties.dataOptionBody
    // A descrição embaixo do título, em cinza; sem título, o texto da opção é ela.
    if (typeof body === 'string')
      return <div className={cn('[&_ol]:my-1 [&_ul]:my-1', body && 'mt-0.5 text-[13px] leading-snug text-muted-foreground')}>{children}</div>
    if (node?.properties.dataOutlineBody === undefined) return <div>{children}</div>
    // O fio sai do meio do selo; os pontos começam onde começa o título.
    return <div className="mt-1 ml-2.5 border-l border-foreground/10 pl-[17px] [&>ol]:my-0 [&>ul]:my-0">{children}</div>
  },
  h1: Heading,
  h2: Heading,
  h3: Subheading,
  a: link(false),
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
  hr: () => <hr className="my-4" />,
  // Imagem com URL abre em tela cheia; caminho local do PC não carrega no celular, vira etiqueta.
  img: ({ src, alt }) => {
    const url = typeof src === 'string' ? src : ''
    if (/^(https?:|data:)/.test(url)) return <ImageThumb src={url} alt={alt} from="Claude" className="max-h-64 w-auto" />
    return (
      <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 font-mono text-xs">
        <ImageIcon className="size-3" />
        {alt || url}
      </span>
    )
  },
  table: Table,
  th: ({ children }) => <th className="border-b bg-muted/50 px-2 py-1.5 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b px-2 py-1.5 align-top">{children}</td>,
}

// O chat ganha os atalhos de copiar; nos outros lugares (README, issue, tarefa) eles só poluiriam.
const chatComponents: Components = { ...components, code: code(true), a: link(true) }

const remarkPlugins = [remarkGfm]
const rehypePlugins = [rehypeColors, rehypeOutline]
// As opções de escolher só existem no chat: num README ou numa issue, uma lista de opções é só uma lista.
const chatRehypePlugins = [rehypeColors, rehypeOptions, rehypeOutline]

/** `chat`: uma resposta do Claude, com o copiar ao lado dos links e dos comandos e as opções de escolher. */
export const Markdown = memo(function Markdown({ text, className, chat = false }: { text: string; chat?: boolean } & ComponentProps<'div'>) {
  return (
    <div className={cn('text-sm break-words', className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={chat ? chatRehypePlugins : rehypePlugins}
        components={chat ? chatComponents : components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

/**
 * Os blocos de um Markdown: corta nas linhas em branco fora de um bloco de código, quando a linha
 * seguinte começa na margem (recuada, ela ainda é do item de lista de cima). Um bloco fechado não muda
 * mais enquanto o texto cresce.
 */
function blocksOf(text: string): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  let start = 0
  let fence = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (f) {
      if (!fence) fence = f
      else if (f[0] === fence[0] && f.length >= fence.length) fence = ''
      continue
    }
    if (fence || line.trim() || i === start) continue
    const next = lines[i + 1]
    if (next === undefined || !/^\S/.test(next)) continue
    out.push(lines.slice(start, i).join('\n'))
    start = i + 1
  }
  out.push(lines.slice(start).join('\n'))
  return out
}

/**
 * O texto que o Claude ainda está escrevendo: um Markdown por bloco, e os já fechados ficam guardados
 * (`memo`), então cada atualização processa só o último, em vez da resposta inteira de novo. O
 * espaçamento entre os blocos é o mesmo de dentro de um só (as margens se juntam).
 */
export function StreamingMarkdown({ text, className, chat }: { text: string; className?: string; chat?: boolean }) {
  return (
    <div className={cn('space-y-2', className)}>
      {blocksOf(text).map((block, i) => (
        <Markdown key={i} text={block} chat={chat} />
      ))}
    </div>
  )
}
