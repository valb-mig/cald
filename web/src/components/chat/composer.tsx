import { ArrowUp, Expand, GitBranch, Loader2, Mic, Shrink, Slash, Square } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/api'
import { toPayload } from '@/lib/attachments'
import { useAttachTarget, useInsertTarget } from '@/lib/compose'
import { spliceSpoken, useDictation, useDictationSupport } from '@/lib/dictation'
import { cachedDraft, loadDraft, saveDraft } from '@/lib/drafts'
import type { AttachmentPayload, ContextUsage, RunOptions, SessionSettings } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useBackToClose } from '@/lib/back-close'
import { useGlass } from '@/lib/wallpaper'
import { AttachmentTray, useAttachments } from './attachment-tray'
import { AddMenu, ContextRing, MODE_TONE, ModeMenu, ModelPill, footerButton, useModels } from './composer-controls'
import { PromptInput, type PromptInputHandle } from './prompt-input'
import { VoiceWave } from './voice-wave'

async function guard(action: () => Promise<void> | void) {
  try {
    await action()
  } catch (err) {
    toast.error(errorMessage(err))
  }
}

/**
 * A linha de controles da caixa (anexar, caixa grande, comandos, contexto, modelo e modo). Não depende
 * do texto, então digitar não a refaz: com os menus do Radix e os ícones, ela era a maior parte do
 * trabalho de cada tecla no celular. Por isso as funções que recebe não mudam de uma tecla para outra.
 */
const Controls = memo(function Controls({
  big,
  models,
  settings,
  context,
  working,
  extra,
  onAttach,
  onMention,
  onToggleBig,
  onSlash,
  onCompact,
  onChangeSettings,
}: {
  big: boolean
  models: ReturnType<typeof useModels>
  settings: SessionSettings
  context: ContextUsage | null
  working: boolean
  extra?: React.ReactNode
  onAttach: () => void
  onMention?: () => void
  onToggleBig: () => void
  onSlash: () => void
  onCompact?: () => void
  onChangeSettings: (patch: RunOptions) => void
}) {
  return (
    <>
      <AddMenu onAttach={onAttach} onMention={onMention} />
      <button
        type="button"
        className={cn(footerButton, 'px-0')}
        onClick={onToggleBig}
        aria-pressed={big}
        aria-label={big ? 'Voltar a caixa ao tamanho normal' : 'Caixa grande, para prompts longos'}
        title={big ? 'Diminuir a caixa' : 'Caixa grande'}
      >
        {big ? <Shrink className="size-4" /> : <Expand className="size-4" />}
      </button>
      <button type="button" className={cn(footerButton, 'px-0')} aria-label="Comandos" onClick={onSlash}>
        <Slash className="size-4" />
      </button>
      {context && onCompact && <ContextRing context={context} disabled={working} onCompact={onCompact} />}
      <ModelPill models={models} settings={settings} onChange={onChangeSettings} />
      {extra}
      <div className="flex-1" />
      <ModeMenu settings={settings} onChange={onChangeSettings} />
    </>
  )
})

/**
 * Caixa de mensagem no formato da extensão do VSCode: texto em cima e, na mesma caixa,
 * a linha com + (anexar/contexto), / (comandos), contexto, modelo, modo e enviar/parar.
 */
export function Composer({
  sessionId,
  cwd,
  working,
  hint,
  branch,
  settings,
  context,
  onChangeSettings,
  onCompact,
  onSend,
  onInterrupt,
  onEdit,
  extra,
}: {
  sessionId: string
  cwd?: string
  /** Claude trabalhando: com o campo vazio, o botão vira "parar"; com texto, a mensagem entra na fila. */
  working: boolean
  hint?: string
  /** Branch do projeto, embaixo da caixa: ali cabe o nome inteiro, que no cabeçalho ficava cortado. */
  branch?: string | null
  settings: SessionSettings
  context: ContextUsage | null
  onChangeSettings: (patch: RunOptions) => Promise<void> | void
  onCompact?: () => Promise<void>
  onSend: (text: string, attachments: AttachmentPayload[]) => Promise<void> | void
  onInterrupt?: () => Promise<void>
  /** O texto mudou pela mão de quem usa (digitar, colar, mencionar): no PC, a aba de prévia vira fixa. */
  onEdit?: () => void
  /** Ao lado do modelo, na barra de baixo: o time de agentes da conversa. */
  extra?: React.ReactNode
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
  const models = useModels()

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
  const showStop = working && empty && Boolean(onInterrupt)
  const mode = settings.permissionMode ?? 'default'
  const tone = MODE_TONE[mode] ?? MODE_TONE.default!

  async function submit() {
    if (empty || sending || files.reading) return
    stopDictation()
    setBig(false)
    setSending(true)
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
  const mention = useCallback(() => input.current?.insert('@'), [])
  const toggleBig = useCallback(() => {
    setBig((b) => !b)
    // O foco volta para o texto: expandir é para escrever, não para olhar.
    requestAnimationFrame(() => input.current?.focus())
  }, [])
  const slash = useCallback(
    () => (latest.current.text.startsWith('/') ? input.current?.focus() : input.current?.insert('/', { atStart: true })),
    [],
  )
  const compact = useCallback(() => void guard(() => latest.current.onCompact?.()), [])
  const changeSettings = useCallback((patch: RunOptions) => void guard(() => latest.current.onChangeSettings(patch)), [])

  async function interrupt() {
    setStopping(true)
    await guard(() => onInterrupt?.())
    setStopping(false)
  }

  return (
    <>
      {big && (
        // Escurece o resto para o texto ficar sozinho na frente; tocar fora fecha.
        <div className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm" onClick={() => setBig(false)} aria-hidden />
      )}
      <div
        data-big={big || undefined}
        className={cn(
          // No PC, a caixa flutua solta no pé da janela, com folga em volta.
          'mx-auto w-full max-w-3xl px-2 pt-1.5 pb-[max(0.5rem,var(--safe-bottom))] compact:pt-1 compact:pb-1 wide:px-4 wide:pb-4',
          big
            ? 'fixed inset-0 z-50 flex max-w-none flex-col justify-center px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]'
            : glass
              ? 'bg-transparent'
              : 'bg-background',
        )}
      >
        {hint && !big && <p className="mb-1.5 px-2 text-xs text-muted-foreground">{hint}</p>}
        <div
          className={cn(
            'relative rounded-2xl border shadow-[0_12px_32px_-18px_rgb(0_0_0/0.35)] transition-[border-color,box-shadow] duration-200',
            big ? 'mx-auto w-full max-w-3xl bg-card shadow-2xl' : glass ? 'bg-card/70 backdrop-blur-md' : 'bg-card',
            tone.focus,
          )}
        >
          {files.items.length > 0 && (
            <div className="border-b px-1.5">
              <AttachmentTray items={files.items} onRemove={files.remove} onEdit={files.update} />
            </div>
          )}
          <PromptInput
            handleRef={input}
            cwd={cwd}
            session={sessionId}
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
                : working
                  ? 'Enfileirar outra mensagem…'
                  : 'Peça algo ao Claude…'
            }
            className={cn(
              'resize-none rounded-none border-0 bg-transparent px-3.5 py-2.5 text-base shadow-none focus-visible:border-0 focus-visible:ring-0 md:text-sm dark:bg-transparent',
              big ? 'max-h-[60dvh] min-h-[45dvh]' : 'max-h-48 min-h-11',
            )}
          />
          <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
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
                big={big}
                models={models}
                settings={settings}
                context={context}
                working={working}
                extra={extra}
                onAttach={attach}
                onMention={cwd ? mention : undefined}
                onToggleBig={toggleBig}
                onSlash={slash}
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
            {showStop ? (
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
                aria-label="Enviar"
              >
                <ArrowUp className="size-4.5" />
              </button>
            )}
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
        {branch && (
          // Deitado, a altura é curta: a branch continua no ⎇ do topo.
          <p
            className={cn(
              'mt-1 flex items-center gap-1 px-2 font-mono text-[11px] text-muted-foreground compact:hidden',
              // Na caixa grande ela centraliza; sem isto a branch ficava solta na borda da tela.
              big && 'mx-auto w-full max-w-3xl',
            )}
          >
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{branch}</span>
          </p>
        )}
      </div>
    </>
  )
}
