import { Check, Copy, ImageIcon } from 'lucide-react'
import { memo, useContext, useEffect, useRef, useState, type ComponentProps, type RefObject } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ImageThumb } from '@/components/image-viewer'
import { ReadingLine } from '@/components/reading-line'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const COLLAPSE_AFTER_LINES = 14

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={className}
      aria-label="Copiar"
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
        <code>{code}</code>
      </pre>
    </div>
  )
}

// ---- leitura em voz alta (ver lib/speech.ts): como a letra no Spotify ----

type HastElement = NonNullable<ExtraProps['node']>
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

function Table({ node, children }: ComponentProps<'table'> & ExtraProps) {
  const [ref, r] = useReading<HTMLDivElement>(node)
  return (
    <div ref={ref} className={cn('my-2 overflow-x-auto rounded-md border', dim(r))}>
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  )
}

const components: Components = {
  pre: Pre,
  code: ({ className, children }) => {
    const text = String(children).replace(/\n$/, '')
    const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1]
    if (lang || text.includes('\n')) return <CodeBlock code={text} lang={lang} />
    return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] break-words">{children}</code>
  },
  p: Paragraph,
  li: ListItem,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  h1: Heading,
  h2: Heading,
  h3: Subheading,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2 break-all">
      {children}
    </a>
  ),
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

export const Markdown = memo(function Markdown({ text, className }: { text: string } & ComponentProps<'div'>) {
  return (
    <div className={cn('text-sm break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
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
export function StreamingMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {blocksOf(text).map((block, i) => (
        <Markdown key={i} text={block} />
      ))}
    </div>
  )
}
