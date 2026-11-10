import { AppWindow, ArrowUp, Check, Code, Expand, GitBranch, Loader2, Lock, Mic, Monitor, Shrink, Square, SquareTerminal } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/api'
import { toPayload } from '@/lib/attachments'
import { useAttachTarget, useContentTarget, useInsertTarget } from '@/lib/compose'
import { spliceSpoken, useDictation, useDictationSupport } from '@/lib/dictation'
import { cachedDraft, loadDraft, saveDraft } from '@/lib/drafts'
import { closeQueued, useQueueEdit } from '@/lib/queue-edit'
import type { AttachmentPayload, ContextUsage, RunOptions, SessionSettings } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useBackToClose } from '@/lib/back-close'
import { useGlass } from '@/lib/wallpaper'
import { useMachine } from '@/lib/machines'
import { CLAUDE, currentMode, useFeatures, useProvider } from '@/lib/providers'
import { AttachmentTray, useAttachments } from './attachment-tray'
import { AttachButton, ContextRing, MODE_TONE, ModeMenu, ModelPill, footerButton, useModels } from './composer-controls'
import { PromptInput, type PromptInputHandle } from './prompt-input'
import { VoiceWave } from './voice-wave'

async function guard(action: () => Promise<void> | void) {
  try {
    await action()
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

/** De onde é a conversa aberta fora do painel, no PC (ver `pcVia` no catálogo). */
export type RemoteVia = 'terminal' | 'vscode' | 'desktop' | 'app'

const REMOTE: Record<RemoteVia, { icon: typeof Code; name: string }> = {
  terminal: { icon: SquareTerminal, name: 'terminal' },
  vscode: { icon: Code, name: 'VSCode' },
  desktop: { icon: Monitor, name: 'app do Claude' },
  app: { icon: AppWindow, name: 'outro app' },
}

// As teclas dos atalhos da caixa grande, pequenas e no tom da borda.
const KBD = 'rounded border bg-muted/60 px-1 font-sans text-[10px] leading-4 text-foreground/80'

/**
 * A linha de controles da caixa (anexar, contexto, agente, modelo e modo). Não
 * depende do texto, então digitar não a refaz: com os menus do Radix e os ícones, ela era a maior parte
 * do trabalho de cada tecla no celular. Por isso as funções que recebe não mudam de uma tecla para outra.
 * `effort` e `modes` são o que o agente da conversa oferece; sem modos, o seletor deles some.
 */
const Controls = memo(function Controls({
  models,
  settings,
  effort,
  modes,
  context,
  working,
  agent,
  extra,
  onAttach,
  onCompact,
  onChangeSettings,
}: {
  models: ReturnType<typeof useModels>
  settings: SessionSettings
  effort: boolean
  modes: string[]
  context: ContextUsage | null
  working: boolean
  agent?: React.ReactNode
  extra?: React.ReactNode
  onAttach: () => void
  onCompact?: () => void
  onChangeSettings: (patch: RunOptions) => void
}) {
  return (
    <>
      <AttachButton onAttach={onAttach} />
      {context && onCompact && <ContextRing context={context} disabled={working} onCompact={onCompact} />}
      {agent}
      <ModelPill models={models} settings={settings} effort={effort} onChange={onChangeSettings} />
      {extra}
      <div className="flex-1" />
      {modes.length > 0 && <ModeMenu settings={settings} modes={modes} onChange={onChangeSettings} />}
    </>
  )
})

/**
 * Caixa de mensagem no formato da extensão do VSCode, numa casca com a branch e a caixa grande em cima:
 * texto e, na mesma caixa, a linha com o clipe (anexar), contexto, modelo, modo e enviar/parar. Os
 * comandos (/) e o contexto do projeto (@) se digitam no texto.
 */
export function Composer({
  sessionId,
  cwd,
  working,
  hint,
  remote,
  branch,
  docked = false,
  settings,
  context,
  onChangeSettings,
  onCompact,
  onSend,
  onInterrupt,
  onEdit,
  provider,
  agent,
  extra,
  above,
}: {
  sessionId: string
  cwd?: string
  /** Claude trabalhando: com o campo vazio, o botão vira "parar"; com texto, a mensagem entra na fila. */
  working: boolean
  hint?: string
  /**
   * Aberta num Claude Code de fora no PC, parada e num lugar de onde o painel consegue tirá-la (o
   * terminal): enviar fecha lá e continua aqui, com todo o contexto. Quando não dá para enviar, quem
   * chama mostra a RemoteDock no lugar da caixa.
   */
  remote?: { via: RemoteVia }
  /** Branch do projeto, na casca em cima da caixa: ali cabe o nome inteiro, que no cabeçalho ficava cortado. */
  branch?: string | null
  /** No pé da conversa, no PC: a casca desce até a barra de baixo e se funde com ela pelas curvas. */
  docked?: boolean
  settings: SessionSettings
  context: ContextUsage | null
  onChangeSettings: (patch: RunOptions) => Promise<void> | void
  onCompact?: () => Promise<void>
  onSend: (text: string, attachments: AttachmentPayload[]) => Promise<void> | void
  onInterrupt?: () => Promise<void>
  /** O texto mudou pela mão de quem usa (digitar, colar, mencionar): no PC, a aba de prévia vira fixa. */
  onEdit?: () => void
  /**
   * O agente da conversa (ver lib/providers.ts): dele vêm os modelos, o esforço e os modos. Sem ele,
   * o padrão da máquina.
   */
  provider?: string
  /** Antes do modelo, na barra de baixo: a escolha do agente, na conversa nova com mais de um ligado. */
  agent?: React.ReactNode
  /** Ao lado do modelo, na barra de baixo: o time de agentes da conversa. */
  extra?: React.ReactNode
  /** No alto da casca, em cima da branch: a fila de mensagens (ver QueueBar). Some na caixa grande. */
  above?: React.ReactNode
}) {
  // Rascunho por conversa: trocar de chat, recarregar a tela ou o Android fechar o app não perde o
  // que foi digitado ou anexado. Sem ele na memória, vem do banco; até lá nada é gravado, para não
  // apagar o salvo.
  const draft = cachedDraft(sessionId)
  const [text, setText] = useState(draft?.text ?? '')
  const files = useAttachments(draft?.attachments)
  const [loaded, setLoaded] = useState(Boolean(draft))
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const input = useRef<PromptInputHandle>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  // De fora do campo também se escreve aqui: mencionar um arquivo pela barra do projeto, por exemplo.
  useInsertTarget(sessionId, (inserted) => input.current?.insert(inserted))
  // E anexar: soltar arquivos em qualquer lugar da conversa cai aqui (ver `useFileDrop`).
  useAttachTarget(sessionId, (list) => void files.add(list))
  // E ler e trocar tudo o que está nela: uma mensagem da fila aberta aqui para editar (ver lib/queue-edit.ts).
  useContentTarget(sessionId, {
    get: () => ({ text, attachments: toPayload(files.items) }),
    set: (content) => {
      setText(content.text)
      files.replace(content.attachments.map((a) => ({ ...a, id: crypto.randomUUID(), size: Math.round((a.data.length * 3) / 4) })))
      input.current?.focus()
    },
  })
  // A mensagem da fila aberta aqui: enviar grava nela, em vez de mandar uma nova.
  const editing = useQueueEdit((s) => Boolean(s[sessionId]))
  const machine = useMachine()
  const models = useModels(provider)
  const info = useProvider(machine, provider)
  const features = useFeatures(machine, provider)

  // Ditado: o que é ouvido entra onde estava o cursor e vai sendo corrigido enquanto se fala.
  const spot = useRef<{ before: string; after: string } | null>(null)
  const canDictate = useDictationSupport()
  const dictation = useDictation({
    onText: (spoken) => {
      const at = spot.current
      if (at) setText(spliceSpoken(at.before, spoken, at.after))
    },
    // Do Whisper, segundos depois de parar: no lugar do cursor se o texto não mudou; se a pessoa
    // digitou nesse meio-tempo, no fim, sem apagar nada.
    onTranscript: (spoken) => {
      // Lido agora: o fim do ditado limpa `spot` antes de o React rodar a função abaixo.
      const at = spot.current
      setText((current) =>
        at && current === at.before + at.after ? spliceSpoken(at.before, spoken, at.after) : spliceSpoken(current, spoken, ''),
      )
    },
    onEnd: () => (spot.current = null),
    onError: (message) => toast.error(message),
  })

  function dictate() {
    if (!dictation.listening) {
      const [start, end] = input.current?.selection() ?? [text.length, text.length]
      spot.current = { before: text.slice(0, start), after: text.slice(end) }
    }
    dictation.toggle()
  }

  // Digitar ou enviar durante o ditado desliga o microfone e fica com o texto como está. Já
  // transcrevendo, o texto do Whisper ainda chega (ver `onTranscript`).
  function stopDictation() {
    if (dictation.transcribing) return
    spot.current = null
    dictation.cancel()
  }

  const { replace } = files
  useEffect(() => {
    if (loaded) return
    let alive = true
    void loadDraft(sessionId).then((saved) => {
      if (!alive) return
      if (saved) {
        setText((typed) => typed || saved.text)
        replace((current) => (current.length ? current : saved.attachments))
      }
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [loaded, sessionId, replace])

  useEffect(() => {
    if (loaded) saveDraft(sessionId, { text, attachments: files.items })
  }, [loaded, sessionId, text, files.items])

  const glass = useGlass()
  /**
   * Caixa grande: para prompts longos, ela sai do rodapé e vira uma folha centrada, com o resto da
   * tela escurecido. É só troca de classe no mesmo elemento — remontar perderia o texto e o cursor.
   */
  const [big, setBig] = useState(false)
  useBackToClose(big, () => setBig(false))
  useEffect(() => {
    if (!big) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setBig(false)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [big])
  const empty = !text.trim() && files.items.length === 0
  const showStop = working && empty && Boolean(onInterrupt) && !editing
  // Em uso: o foco está nela (ou num menu dela, que abre fora: o modelo, o modo). Fora de uso e vazia, ela
  // fica numa linha só, sem a branch nem a caixa grande; tocar abre de novo, subindo.
  const root = useRef<HTMLDivElement>(null)
  const [using, setUsing] = useState(false)
  useEffect(() => {
    const el = root.current
    if (!el) return
    const away = (t: EventTarget | null) =>
      t instanceof Node && !el.contains(t) && !(t instanceof Element && t.closest('[data-radix-popper-content-wrapper],[role="dialog"]'))
    // Mexer na fila, no alto da casca, não abre a caixa.
    const onIn = (e: FocusEvent) => !(e.target instanceof Element && e.target.closest('[data-composer-above]')) && setUsing(true)
    // Sem destino (a janela perdeu o foco, um clique no vazio), quem decide é o toque fora, logo abaixo.
    const onOut = (e: FocusEvent) => away(e.relatedTarget) && setUsing(false)
    const onDown = (e: PointerEvent) => away(e.target) && setUsing(false)
    el.addEventListener('focusin', onIn)
    el.addEventListener('focusout', onOut)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      el.removeEventListener('focusin', onIn)
      el.removeEventListener('focusout', onOut)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [])
  // Aberta lá fora, a casca fica à vista: o chip dela diz onde.
  const oneLine = !big && !using && empty && !dictation.listening && !dictation.transcribing && !remote
  // A altura que abre e fecha (a casca de cima, a linha dos controles), deslizando; sem, com movimento reduzido.
  const fold = (open: boolean) =>
    cn('grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none', open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')
  // Na linha só, o clipe e o enviar ficam ao lado do texto; aberta, vão para a linha dos controles.
  const side = (open: boolean) =>
    cn('grid shrink-0 transition-[grid-template-columns,opacity] duration-200 ease-out motion-reduce:transition-none', open ? 'grid-cols-[1fr] opacity-100' : 'grid-cols-[0fr] opacity-0')
  const mode = currentMode(settings, features.permissionModes)
  const tone = MODE_TONE[mode] ?? MODE_TONE.default!

  async function submit() {
    if (empty || sending || files.reading) return
    stopDictation()
    setBig(false)
    setSending(true)
    if (editing) {
      // Grava na mensagem da fila e a caixa volta ao que tinha antes de abri-la.
      await closeQueued(sessionId).catch((err: unknown) => toast.error('Não deu para salvar na fila', { description: errorMessage(err) }))
      setSending(false)
      return
    }
    try {
      await onSend(text.trim(), toPayload(files.items))
      setText('')
      files.clear()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSending(false)
    }
  }

  // Os controles leem o texto e as funções de quem chama na hora do clique, sem mudar a cada tecla.
  const latest = useRef({ text, onChangeSettings, onCompact })
  useLayoutEffect(() => {
    latest.current = { text, onChangeSettings, onCompact }
  })
  const attach = useCallback(() => fileInput.current?.click(), [])
  const toggleBig = useCallback(() => {
    setBig((b) => !b)
    // O foco volta para o texto: expandir é para escrever, não para olhar.
    requestAnimationFrame(() => input.current?.focus())
  }, [])
  const compact = useCallback(() => void guard(() => latest.current.onCompact?.()), [])
  const changeSettings = useCallback((patch: RunOptions) => void guard(() => latest.current.onChangeSettings(patch)), [])

  async function interrupt() {
    setStopping(true)
    await guard(() => onInterrupt?.())
    setStopping(false)
  }

  // Enviar, ou parar com o campo vazio enquanto ele trabalha: na linha dos controles e, numa linha só, ao lado do texto.
  const sendButton = showStop ? (
    <button
      type="button"
      onClick={interrupt}
      disabled={stopping}
      className={cn('ml-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg disabled:opacity-40', tone.send)}
      aria-label="Parar"
    >
      <Square className="size-3.5 fill-current" />
    </button>
    ) : (
    <button
      type="button"
      onClick={submit}
      disabled={empty || sending || files.reading}
      className={cn(
        'ml-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg transition-[filter] hover:brightness-110 disabled:opacity-40',
        tone.send,
      )}
      aria-label={editing ? 'Salvar na fila' : 'Enviar'}
      title={editing ? 'Salvar na fila' : undefined}
    >
      {editing ? <Check className="size-4.5" /> : <ArrowUp className="size-4.5" />}
    </button>
    )

  return (
    <>
      {big && (
        // Escurece o resto para o texto ficar sozinho na frente; tocar fora fecha.
        <div className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm" onClick={() => setBig(false)} aria-hidden />
      )}
      <div
        ref={root}
        data-big={big || undefined}
        className={cn(
          // No PC, a caixa flutua solta no pé da janela, com folga em volta; presa (`docked`), desce até o pé.
          'mx-auto w-full max-w-3xl px-2 pt-1.5 pb-[max(0.5rem,var(--safe-bottom))] compact:pt-1 compact:pb-1 wide:px-4',
          docked && !big ? 'wide:pb-0' : 'wide:pb-4',
          // Sem fundo próprio: ele ficava quadrado e de outro tom quando a caixa está sobre uma superfície
          // (cartão da Mesa, conversa nova do hub). A caixa é irmã da lista, não cobre nada que role.
          big && 'fixed inset-0 z-50 flex max-w-none flex-col justify-center px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]',
        )}
      >
        {hint && !big && <p className="mb-1.5 px-2 text-xs text-muted-foreground">{hint}</p>}
        {/* A casca da caixa: em cima, a branch à esquerda e a caixa grande na ponta direita. Deitado, a
            altura é curta: a casca some, e a branch continua no ⎇ do topo. */}
        <div
          className={cn(
            big
              ? // Grande, a casca vira a própria janela de escrita: a faixa de cima é o cabeçalho dela.
                'mx-auto w-full max-w-3xl overflow-hidden rounded-[20px] border bg-card shadow-2xl'
              : cn(
                  // No tom da casca do app (quase preto no escuro): a caixa cinza não some num cinza parecido.
                  // 8px de casca em volta da caixa (raio 16 + 8 = 24, para as curvas ficarem paralelas).
                  'rounded-[24px] px-2 pb-2 transition-[padding] duration-200 ease-out motion-reduce:transition-none compact:bg-transparent compact:p-0',
                  // Numa linha só, sem a faixa de cima: os 8px em volta valem também em cima (a fila, se houver, já os dá).
                  oneLine && !above && 'pt-2',
                  docked ? cn('dock-tab relative rounded-b-none', glass && 'dock-glass backdrop-blur-md') : glass ? 'bg-shell/70 backdrop-blur-md' : 'bg-shell',
                ),
          )}
        >
          {above && !big && (
            <div data-composer-above className="compact:hidden">
              {above}
            </div>
          )}
          <div className={cn(fold(!oneLine), 'compact:hidden')} inert={oneLine}>
            <div className="min-h-0 overflow-hidden">
              <div className={cn('flex items-center gap-2 text-[11px] text-muted-foreground', big ? 'h-11 border-b px-3.5' : 'h-8 pr-0 pl-2')}>
                {remote && <RemoteChip {...remote} />}
                {branch && (
                  <span className="flex min-w-0 items-center gap-1 font-mono">
                    <GitBranch className="size-3 shrink-0" />
                    <span className="truncate">{branch}</span>
                  </span>
                )}
                {/* Grande, os atalhos que valem nela (no toque, sem teclado, não). */}
                {big && (
                  <span className="ml-auto hidden items-center gap-1 pointer-fine:flex">
                    <kbd className={KBD}>Ctrl</kbd>
                    <kbd className={KBD}>Enter</kbd>
                    envia ·<kbd className={KBD}>Esc</kbd>
                    fecha
                  </span>
                )}
                <button
                  type="button"
                  onClick={toggleBig}
                  aria-pressed={big}
                  aria-label={big ? 'Voltar a caixa ao tamanho normal' : 'Caixa grande, para prompts longos'}
                  title={big ? 'Diminuir a caixa' : 'Caixa grande'}
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-foreground/5 hover:text-foreground',
                    big ? 'ml-auto pointer-fine:ml-1' : 'ml-auto',
                  )}
                >
                  {big ? <Shrink className="size-3.5" /> : <Expand className="size-3.5" />}
                </button>
              </div>
            </div>
          </div>
          <div
            className={cn(
              'relative transition-[border-color,box-shadow] duration-200',
              // Grande, a caixa é o miolo da janela: sem borda nem brilho próprios (a cor do modo fica no enviar).
              big
                ? 'bg-transparent'
                : cn('rounded-2xl border shadow-[0_12px_32px_-18px_rgb(0_0_0/0.35)]', glass ? 'bg-card/70 backdrop-blur-md' : 'bg-card', tone.focus),
            )}
          >
            {files.items.length > 0 && (
              <div className="border-b px-1.5">
                <AttachmentTray items={files.items} onRemove={files.remove} onEdit={files.update} />
              </div>
            )}
            <div className="flex items-end">
              <div className={side(oneLine)} inert={!oneLine}>
                <div className="min-w-0 overflow-hidden py-1.5 pl-1.5">
                  <AttachButton onAttach={attach} />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <PromptInput
                  handleRef={input}
                  cwd={cwd}
                  session={sessionId}
                  provider={provider}
                  value={text}
                  onChange={(value) => {
                    stopDictation()
                    setText(value)
                    if (value.trim()) onEdit?.()
                  }}
                  onPasteFiles={files.add}
                  onSubmitShortcut={submit}
                  anchored={false}
                  rows={1}
                  placeholder={
                    dictation.listening
                      ? dictation.live
                        ? 'Pode falar…'
                        : 'Gravando… toque no microfone para transcrever'
                      : remote
                        ? `Enviar traz a conversa do ${REMOTE[remote.via].name} para cá…`
                        : editing
                          ? 'Editando a mensagem da fila…'
                          : working
                          ? 'Enfileirar outra mensagem…'
                          : `Peça algo ao ${!info || info.id === CLAUDE ? 'Claude' : info.name}…`
                  }
                  className={cn(
                    'resize-none rounded-none border-0 bg-transparent px-3.5 py-2.5 text-base shadow-none focus-visible:border-0 focus-visible:ring-0 md:text-sm dark:bg-transparent',
                    big ? 'max-h-[60dvh] min-h-[45dvh] px-6 py-5 text-[15px] leading-relaxed md:text-[15px]' : 'max-h-48 min-h-11',
                    oneLine && 'pl-2',
                  )}
                />
              </div>
              <div className={side(oneLine)} inert={!oneLine}>
                <div className="min-w-0 overflow-hidden py-1.5 pr-1.5">{sendButton}</div>
              </div>
            </div>
            {/* Medida para os controles: numa caixa estreita (a mesa do projeto), o modo fica só no ícone. */}
            <div className={fold(!oneLine)} inert={oneLine}>
              <div className="min-h-0 overflow-hidden">
                <div className={cn('@container flex items-center gap-0.5', big ? 'border-t px-3 py-2' : 'px-1.5 pb-1.5')}>
                  {/* Durante o ditado, as ondas da voz ocupam a linha no lugar dos controles. */}
                  {dictation.listening ? (
                    <VoiceWave activity={text} speaking={dictation.speaking} className="mx-2 h-6 min-w-0 flex-1 text-red-500" />
                  ) : dictation.transcribing ? (
                    <div className="mx-2 flex h-6 min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground" role="status">
                      <Loader2 className="size-3.5 shrink-0 animate-spin" />
                      <span className="truncate">Transcrevendo no PC…</span>
                    </div>
                  ) : (
                    <Controls
                      models={models}
                      settings={settings}
                      effort={features.effort}
                      modes={features.permissionModes}
                      context={context}
                      working={working}
                      agent={agent}
                      extra={extra}
                      onAttach={attach}
                      onCompact={onCompact ? compact : undefined}
                      onChangeSettings={changeSettings}
                    />
                  )}
                  {canDictate && (
                    <button
                      type="button"
                      onClick={dictate}
                      disabled={dictation.transcribing}
                      className={cn(footerButton, 'px-0', dictation.listening && 'bg-red-500/15 text-red-500 hover:bg-red-500/15 hover:text-red-500')}
                      aria-label={dictation.transcribing ? 'Transcrevendo' : dictation.listening ? (dictation.live ? 'Parar ditado' : 'Parar e transcrever') : 'Ditar'}
                      aria-pressed={dictation.listening}
                    >
                      {dictation.transcribing ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Mic className={cn('size-4', dictation.listening && 'animate-pulse')} />
                      )}
                    </button>
                  )}
                  {sendButton}
                </div>
              </div>
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void files.add(e.target.files)
                e.target.value = ''
              }}
            />
          </div>
        </div>
      </div>
    </>
  )
}

/** Onde a conversa está aberta fora do edit.r, no alto da caixa; a dica diz o que enviar faz. */
function RemoteChip({ via }: { via: RemoteVia }) {
  const { icon: Icon, name } = REMOTE[via]
  const tip = `Aberta no ${name} do PC. Enviar fecha lá e continua aqui, com todo o contexto.`
  return (
    <span title={tip} aria-label={tip} className="flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.06] py-0.5 pr-2 pl-1.5 text-foreground/80">
      <Icon className="size-3" />
      {name}
    </span>
  )
}

/**
 * No lugar da caixa, quando daqui não dá para enviar: a conversa trabalha lá fora (`busy`; parando, a
 * caixa volta), ou está num lugar de onde o painel não a tira (o VSCode, outro app). Uma aba pequena no
 * pé, com o ícone de onde ela está: presa à barra de baixo no PC (`docked`), solta no celular.
 */
export function RemoteDock({ via, busy, docked = false }: { via: RemoteVia; busy: boolean; docked?: boolean }) {
  const { icon: Icon, name } = REMOTE[via]
  const tip = busy ? `Trabalhando no ${name} do PC. A caixa volta quando ela parar.` : `Aberta no ${name} do PC. Feche lá para continuar aqui.`
  return (
    <div className={cn('flex justify-center px-2 pt-1.5 pb-[max(0.5rem,var(--safe-bottom))] compact:pt-1 compact:pb-1 wide:px-4', docked ? 'wide:pb-0' : 'wide:pb-4')}>
      <div
        role="status"
        title={tip}
        className={cn(
          'flex items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground',
          docked ? 'dock-tab relative rounded-t-[20px]' : 'rounded-full bg-shell',
        )}
      >
        <Icon className="size-4 shrink-0 text-foreground/80" />
        <span>{busy ? `Trabalhando no ${name}` : `Aberta no ${name}`}</span>
        {busy ? (
          <span aria-hidden className="size-1.5 rounded-full bg-sky-500 motion-safe:animate-pulse" />
        ) : (
          <Lock aria-hidden className="size-3.5 shrink-0" />
        )}
        <span className="sr-only">{tip}</span>
      </div>
    </div>
  )
}
