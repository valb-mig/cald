import { toast } from 'sonner'
import { create } from 'zustand'
import { ApiError, api, errorMessage } from './api'
import { onRekey } from './store'

/**
 * Ler as respostas do Claude em voz alta com a voz do próprio aparelho: no Android, o motor de texto
 * para fala do sistema (o dos "Serviços de fala do Google", com vozes em pt-BR que funcionam sem
 * internet depois de baixadas). Nada roda no PC, a não ser no próprio PC: lá a voz do navegador é a do
 * espeak, robótica, e com o Piper instalado a fala é gerada pelo servidor (ver "Voz do PC", abaixo).
 *
 * A leitura vai uma frase por vez: dá para pausar, pular pela barra e destacar no texto o trecho
 * que está sendo lido.
 */
const synth = 'speechSynthesis' in window ? window.speechSynthesis : null

/** Navegador com leitura em voz alta (Chrome, Safari, Firefox). */
export const speechSupported = Boolean(synth)

/** Pedaço falado de uma vez (uma frase, ou parte de uma frase longa) e a linha do markdown de onde veio. */
export type Unit = { text: string; line: number }

export type Reading = {
  /** Mensagem sendo lida: `<sessão>:<mensagem>`, porque várias conversas podem estar na tela (split). */
  key: string
  units: Unit[]
  /** Pedaço em leitura ou, pausado, de onde continua. */
  index: number
  playing: boolean
  /** Quanto já foi lido, de 0 a 1. */
  progress: number
}

// Leitura automática (o alto-falante no topo do chat) e velocidade: valem para todas as conversas e ficam salvas.
// Quais conversas leem as respostas sozinhas. Antes era uma chave para todas; com conversas lado a
// lado, ligar numa passava a ler as duas.
const AUTO_KEY = 'cr:speech-auto-chats'

function savedAuto(): string[] {
  try {
    const raw = JSON.parse(saved(AUTO_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
const RATE_KEY = 'cr:speech-rate'

/** Velocidades da barra de leitura, na ordem em que o botão passa por elas. */
export const SPEEDS = [1, 1.5, 2, 3]

function saved(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage indisponível (modo privado): segue só em memória.
  }
}

/** Leitura atual (uma por vez no app inteiro), as conversas que leem as respostas novas sozinhas e a velocidade da voz. */
export const useSpeech = create<{ reading: Reading | null; auto: string[]; rate: number }>(() => ({
  reading: null,
  auto: speechSupported ? savedAuto() : [],
  rate: SPEEDS.find((r) => String(r) === saved(RATE_KEY)) ?? 1,
}))

// ---------------------------------------------------------------------------
// Markdown → frases faladas
// ---------------------------------------------------------------------------

// O Chrome corta falas longas no meio (e o Android recusa textos enormes).
const MAX_CHUNK = 220

// Caminho com pasta e extensão (web/src/lib/api.ts, ~/x/y.md:42): falado, só o nome do arquivo interessa.
const PATH = /(?:~|\.{1,2})?\/?(?:[\w.@-]+\/)+([\w@-]+\.\w+)(?::\d+(?:-\d+)?)?/g

// Linha que abre um bloco novo; qualquer outra logo abaixo de texto continua o mesmo parágrafo ou item.
const BLOCK_START = /^(#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/

function speakableLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S*[^\s.,;:!?)\]]/g, 'um link')
    .replace(/`([^`]+)`/g, '$1')
    .replace(PATH, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2')
    .replace(/\s*→\s*/g, ', ')
    .trim()
}

/** Frases de um bloco; uma frase longa demais é cortada nas vírgulas e, se ainda não der, entre palavras. */
function sentences(text: string): string[] {
  const out: string[] = []
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    if (sentence.length <= MAX_CHUNK) {
      out.push(sentence)
      continue
    }
    let current = ''
    const add = (part: string) => {
      if (current && current.length + part.length + 1 > MAX_CHUNK) {
        out.push(current)
        current = ''
      }
      current = current ? `${current} ${part}` : part
    }
    for (const part of sentence.split(/(?<=[,;])\s+/)) {
      if (part.length <= MAX_CHUNK) add(part)
      else part.split(/\s+/).forEach(add)
    }
    if (current) out.push(current)
  }
  return out
}

/**
 * Markdown do Claude em frases que soam bem faladas, cada uma com a linha de onde veio: código e
 * tabelas viram um aviso, caminhos viram o nome do arquivo, links viram "um link".
 */
export function speechUnits(markdown: string): Unit[] {
  const blocks: Unit[] = []
  let fence = false
  let table = false
  // O último bloco é texto que a linha de baixo pode continuar.
  let open = false
  markdown.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      if (!fence) blocks.push({ text: 'Tem um trecho de código na tela.', line: i + 1 })
      fence = !fence
      open = false
      return
    }
    if (fence) return
    if (line.startsWith('|')) {
      if (!table) blocks.push({ text: 'Tem uma tabela na tela.', line: i + 1 })
      table = true
      open = false
      return
    }
    table = false
    if (!line || /^([-*_])\1{2,}$/.test(line)) {
      open = false
      return
    }
    const spoken = speakableLine(line)
    if (!spoken) return
    if (open && !BLOCK_START.test(line)) blocks[blocks.length - 1].text += ` ${spoken}`
    else blocks.push({ text: spoken, line: i + 1 })
    open = !/^#{1,6}\s/.test(line)
  })
  return blocks.flatMap((block) => {
    // Títulos e itens de lista sem ponto final emendariam na frase seguinte sem pausa.
    const text = /[.!?:;…]$/.test(block.text) ? block.text : `${block.text}.`
    return sentences(text).map((s) => ({ text: s, line: block.line }))
  })
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

// A voz é a padrão do aparelho para pt-BR (no Android, a de Configurações › Texto para fala; no Linux,
// a do speech-dispatcher): escolher outra por cima pegava vozes online que falham sem estar baixadas.

// Voz do PC: no Linux, a padrão é a do espeak, robótica. Com o Piper instalado no PC (ver
// server/src/speak.ts), cada frase é gerada lá, com voz neural e sem internet, e tocada aqui. O
// celular segue com a voz dele, que já é boa e não depende do PC.
const audio = new Audio()
let piper = false
if (!/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  void api.speakStatus().then(
    (s) => (piper = s.available),
    () => {},
  )
}
// Frases da mensagem em leitura já pedidas ao PC: a atual e a seguinte, gerada enquanto a atual toca.
const clips = new Map<number, Promise<Blob>>()
// Mensagem em que a voz do PC falhou: o resto dela vai com a voz do navegador, sem um aviso por frase.
let piperFailedOn: string | null = null
// A voz do PC está gerando ou tocando a frase atual (o `audio` parado não quer dizer silêncio).
let clipActive = false
let clipUrl: string | null = null

const ERRORS: Partial<Record<SpeechSynthesisErrorCode, string>> = {
  'language-unavailable': 'O aparelho não tem voz em português. Instale em Configurações › Texto para fala.',
  'voice-unavailable': 'O aparelho não tem voz em português. Instale em Configurações › Texto para fala.',
  'synthesis-unavailable': 'O aparelho não tem um motor de texto para fala ativo.',
  'audio-busy': 'O áudio está ocupado por outro app.',
  'not-allowed': 'O navegador só deixa o app falar depois de um toque na tela. Toque em Ouvir.',
  network: 'A voz do aparelho precisa de internet e não conseguiu falar.',
  'synthesis-failed': 'O motor de voz do aparelho falhou (synthesis-failed). Confira a voz em Configurações › Texto para fala.',
}

// Cada interrupção (pausar, pular, outra mensagem) invalida os avisos da fala anterior.
let generation = 0
// Referência à fala atual: sem ela, o Chrome pode descartar a fala e nunca avisar o fim.
let current: SpeechSynthesisUtterance | null = null
let ticker: ReturnType<typeof setInterval> | undefined
// Velocidade da voz em caracteres por segundo, em 1x, ajustada a cada frase: faz a barra andar dentro
// da frase quando o aparelho não avisa por qual palavra está.
let charsPerSecond = 14
// Respostas que chegaram com outra sendo lida (leitura automática): esperam a vez, na ordem.
let queue: { key: string; markdown: string }[] = []

const patch = (change: Partial<Reading>) =>
  useSpeech.setState((s) => (s.reading ? { reading: { ...s.reading, ...change } } : s))

function progressAt(units: Unit[], index: number, within = 0): number {
  let before = 0
  let total = 0
  units.forEach((u, i) => {
    if (i < index) before += u.text.length
    total += u.text.length
  })
  return total ? Math.min(1, (before + within) / total) : 0
}

function silence(): void {
  generation++
  clearInterval(ticker)
  // A fala cortada ainda avisaria erro ou fim; isso não interessa mais.
  if (current) current.onend = current.onerror = null
  current = null
  synth?.cancel()
  audio.onended = audio.onerror = null
  audio.pause()
  releaseClip()
}

function releaseClip(): void {
  if (clipUrl) URL.revokeObjectURL(clipUrl)
  clipUrl = null
  clipActive = false
}

/** Frase `index` pedida ao PC; a mesma promessa se já foi pedida. */
function clip(units: Unit[], index: number): Promise<Blob> | undefined {
  if (index >= units.length) return undefined
  let blob = clips.get(index)
  if (!blob) {
    blob = api.speak(units[index].text)
    // A falha de uma frase pedida adiantada só importa quando chegar a vez dela.
    blob.catch(() => {})
    clips.set(index, blob)
  }
  return blob
}

/** Como `speakFrom`, com a voz do PC: toca a frase `index` e já pede a seguinte. */
function speakClip(reading: Reading, index: number, gen: number): void {
  const { units } = reading
  for (const i of clips.keys()) if (i !== index && i !== index + 1) clips.delete(i)
  const blob = clip(units, index)!
  clip(units, index + 1)
  clipActive = true
  patch({ index, playing: true, progress: progressAt(units, index) })
  const failed = (why: string) => {
    if (gen !== generation) return
    // PC fora do ar ou Piper com problema: a mensagem segue com a voz do navegador.
    releaseClip()
    piperFailedOn = reading.key
    toast.error(`${why} Seguindo com a voz do navegador.`)
    speakFrom(index, gen)
  }
  blob.then(
    (data) => {
      if (gen !== generation) return
      clipUrl = URL.createObjectURL(data)
      audio.src = clipUrl
      // Acelera sem afinar (o `preservesPitch` vem ligado), até os 3x da barra.
      audio.defaultPlaybackRate = audio.playbackRate = useSpeech.getState().rate
      audio.onended = () => {
        if (gen !== generation) return
        releaseClip()
        speakFrom(index + 1, gen)
      }
      audio.onerror = () => failed('O navegador não conseguiu tocar a voz do PC.')
      ticker = setInterval(() => {
        const within = audio.duration ? (units[index].text.length * audio.currentTime) / audio.duration : 0
        patch({ progress: progressAt(units, index, within) })
      }, 100)
      audio.play().catch((err: unknown) => {
        if (gen !== generation) return
        if (!(err instanceof DOMException && err.name === 'NotAllowedError')) return failed('O navegador não conseguiu tocar a voz do PC.')
        pauseSpeech()
        toast.error(ERRORS['not-allowed'])
      })
    },
    (err: unknown) => failed(err instanceof ApiError ? errorMessage(err) : 'O PC não respondeu.'),
  )
}

/** Fala o pedaço `index` e, ao terminar, o seguinte, até o fim da mensagem. */
function speakFrom(index: number, gen: number): void {
  const reading = useSpeech.getState().reading
  if (!synth || !reading || gen !== generation) return
  clearInterval(ticker)
  clipActive = false
  if (index >= reading.units.length) {
    current = null
    useSpeech.setState({ reading: null })
    const next = queue.shift()
    if (next) start(next.key, next.markdown)
    return
  }
  if (piper && piperFailedOn !== reading.key) return speakClip(reading, index, gen)
  const { text } = reading.units[index]
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'pt-BR'
  // A voz do aparelho acelera sem afinar; acima do que ela aguenta, para de acelerar (o teto varia por voz).
  const rate = useSpeech.getState().rate
  utterance.rate = rate
  let startedAt = performance.now()
  let spokenChars = 0
  utterance.onstart = () => {
    startedAt = performance.now()
  }
  utterance.onboundary = (e) => {
    spokenChars = e.charIndex
  }
  utterance.onend = () => {
    if (gen !== generation) return
    const seconds = (performance.now() - startedAt) / 1000
    if (seconds > 0.5) charsPerSecond = 0.7 * charsPerSecond + 0.3 * (text.length / seconds / rate)
    speakFrom(index + 1, gen)
  }
  utterance.onerror = (e) => {
    if (gen !== generation) return
    // As interrupções do app desligam os avisos antes (ver `silence`): esta veio de fora, como o
    // Android cortando a fala com a tela apagada ou uma ligação. Fica pausado na frase atual.
    if (e.error === 'interrupted' || e.error === 'canceled') return pauseSpeech()
    stopSpeaking()
    toast.error(
      e.error
        ? (ERRORS[e.error] ?? `Não deu para ler em voz alta (${e.error}).`)
        : // O Firefox não diz o motivo. No Linux, o caso comum é a ligação dele com o speech-dispatcher ter
          // morrido quando o serviço reiniciou (ele não refaz): só fechar e abrir o navegador resolve.
          'O navegador não conseguiu falar e não disse o motivo. No PC com Linux, feche e abra o navegador de novo.',
    )
  }
  current = utterance
  patch({ index, playing: true, progress: progressAt(reading.units, index) })
  synth.speak(utterance)
  ticker = setInterval(() => {
    const estimate = Math.min(text.length * 0.97, ((performance.now() - startedAt) / 1000) * charsPerSecond * rate)
    patch({ progress: progressAt(reading.units, index, spokenChars || estimate) })
  }, 100)
}

/** Interrompe o que estiver falando e começa do pedaço `index`. */
function playFrom(index: number): void {
  const busy = Boolean(synth?.speaking || synth?.pending)
  silence()
  const gen = generation
  // Logo depois de um `cancel`, alguns Chrome ignoram a fala nova: dá um respiro antes.
  if (busy) setTimeout(() => speakFrom(index, gen), 60)
  else speakFrom(index, gen)
}

function start(key: string, markdown: string): void {
  const units = speechUnits(markdown)
  if (!units.length) {
    const next = queue.shift()
    if (next) start(next.key, next.markdown)
    return
  }
  clips.clear()
  piperFailedOn = null
  useSpeech.setState({ reading: { key, units, index: 0, playing: true, progress: 0 } })
  playFrom(0)
}

/**
 * Ouvir, pausar ou continuar a mensagem `key`. Outra mensagem que estiver tocando é interrompida,
 * e as respostas na fila da leitura automática são descartadas: quem escolheu foi a pessoa.
 */
export function toggleSpeech(key: string, markdown: string): void {
  if (!synth) return
  const reading = useSpeech.getState().reading
  if (reading?.key === key) {
    if (reading.playing) pauseSpeech()
    else playFrom(reading.index)
    return
  }
  queue = []
  start(key, markdown)
}

/** Leitura automática: lê a resposta que acabou de chegar; com outra tocando ou pausada, entra na fila. */
export function speakNew(sessionId: string, key: string, markdown: string): void {
  if (!synth || !useSpeech.getState().auto.includes(sessionId)) return
  if (useSpeech.getState().reading) queue.push({ key, markdown })
  else start(key, markdown)
}

/** Liga ou desliga a leitura automática de uma conversa; desligar cala só o que for dela — a do lado segue. */
export function setAutoSpeech(sessionId: string, on: boolean): void {
  const rest = useSpeech.getState().auto.filter((id) => id !== sessionId)
  const auto = on ? [...rest, sessionId] : rest
  save(AUTO_KEY, JSON.stringify(auto))
  useSpeech.setState({ auto })
  if (!on) stopSpeakingIn(sessionId)
}

// O /clear dá id novo à conversa: a leitura automática dela continua ligada.
onRekey((from, to) => {
  if (useSpeech.getState().auto.includes(from)) setAutoSpeech(to, true)
})

/**
 * Troca a velocidade da voz. A do PC muda na hora; a do aparelho não muda de ritmo no meio de uma
 * fala, então a frase atual recomeça já na velocidade nova.
 */
export function setSpeechRate(rate: number): void {
  save(RATE_KEY, String(rate))
  useSpeech.setState({ rate })
  const reading = useSpeech.getState().reading
  if (!reading?.playing) return
  if (clipActive) audio.defaultPlaybackRate = audio.playbackRate = rate
  else playFrom(reading.index)
}

/** Pausa no começo da frase atual; continuar repete a frase desde o início. */
export function pauseSpeech(): void {
  const reading = useSpeech.getState().reading
  if (!reading) return
  silence()
  patch({ playing: false, progress: progressAt(reading.units, reading.index) })
}

export function resumeSpeech(): void {
  const reading = useSpeech.getState().reading
  if (reading && !reading.playing) playFrom(reading.index)
}

/** Pula para a frase em `fraction` (0 a 1) da mensagem; tocando, continua a partir dela. */
export function seekSpeech(fraction: number): void {
  const reading = useSpeech.getState().reading
  if (!reading) return
  const total = reading.units.reduce((n, u) => n + u.text.length, 0)
  let index = 0
  for (let end = 0; index < reading.units.length - 1; index++) {
    end += reading.units[index].text.length
    if (end > fraction * total) break
  }
  if (reading.playing) playFrom(index)
  else patch({ index, progress: progressAt(reading.units, index) })
}

export function stopSpeaking(): void {
  queue = []
  silence()
  useSpeech.setState({ reading: null })
}

/** Conversa saindo da tela: cala a leitura se for dela e tira da fila as respostas dela; as outras seguem. */
export function stopSpeakingIn(sessionId: string): void {
  const prefix = `${sessionId}:`
  queue = queue.filter((q) => !q.key.startsWith(prefix))
  if (!useSpeech.getState().reading?.key.startsWith(prefix)) return
  silence()
  useSpeech.setState({ reading: null })
  const next = queue.shift()
  if (next) start(next.key, next.markdown)
}

// Voltando ao app: se a fala parou enquanto a tela estava apagada sem avisar, mostra pausado (e
// não um "Pausar" sem som).
document.addEventListener('visibilitychange', () => {
  const reading = useSpeech.getState().reading
  if (!document.hidden && reading?.playing && !clipActive && !synth?.speaking && !synth?.pending) pauseSpeech()
})
