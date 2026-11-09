import { useEffect, useState } from 'react'
import { api, errorMessage } from './api'
import { blobToBase64 } from './attachments'
import { desktop } from './desktop'

/** O que o TypeScript não declara do reconhecedor de voz (no Chrome ele ainda é `webkitSpeechRecognition`). */
type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: SpeechRecognitionEvent) => void) | null
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  onspeechstart: (() => void) | null
  onspeechend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

const speech = window as unknown as {
  SpeechRecognition?: new () => Recognition
  webkitSpeechRecognition?: new () => Recognition
}
// No app do PC o reconhecedor existe, mas sem o serviço do Google atrás: lá o ditado é o do Whisper.
const Recognizer = desktop ? undefined : (speech.SpeechRecognition ?? speech.webkitSpeechRecognition)

/** Navegador com ditado ao vivo (Chrome e Safari). Sem ele (Firefox, o app do PC), o ditado grava e o PC transcreve com o Whisper. */
const liveDictation = Boolean(Recognizer)

let whisper: Promise<boolean> | undefined

/** Dá para ditar aqui: ao vivo pelo navegador ou, sem isso, gravando para o Whisper do PC (se estiver instalado). */
export function useDictationSupport(): boolean {
  const [whisperReady, setWhisperReady] = useState(false)
  useEffect(() => {
    if (liveDictation || !navigator.mediaDevices?.getUserMedia || !('MediaRecorder' in window)) return
    whisper ??= api.transcribeStatus().then((s) => s.available, () => false)
    let alive = true
    void whisper.then((ok) => alive && setWhisperReady(ok))
    return () => {
      alive = false
    }
  }, [])
  return liveDictation || whisperReady
}

// Só os erros que encerram o ditado; "no-speech" (silêncio) e "aborted" deixam a próxima rodada ouvir.
const ERRORS: Partial<Record<SpeechRecognitionErrorCode, string>> = {
  'not-allowed': 'Libere o microfone para o app nas configurações do navegador.',
  'service-not-allowed': 'Libere o microfone para o app nas configurações do navegador.',
  'audio-capture': 'Nenhum microfone encontrado.',
  network: 'Sem internet: o ditado precisa de conexão.',
  'language-not-supported': 'Este navegador não faz ditado em português.',
}

const join = (a: string, b: string) => (a && b ? `${a} ${b}` : a || b)

/** Encaixa o ditado entre o texto de antes e o de depois, com espaços e maiúscula no começo de frase. */
export function spliceSpoken(before: string, spoken: string, after: string): string {
  if (!spoken) return before + after
  const sentence = /(^|[.!?\n])\s*$/.test(before)
  const text = sentence ? spoken.charAt(0).toUpperCase() + spoken.slice(1) : spoken
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  return before + lead + text + trail + after
}

type Handlers = {
  /** Tudo o que foi ouvido desde que o microfone ligou; vai sendo corrigido enquanto a pessoa fala. */
  onText: (spoken: string) => void
  /** Ditado gravado (Whisper): o texto inteiro, de uma vez, segundos depois de parar. */
  onTranscript: (spoken: string) => void
  /** Fim do ditado: parado pela pessoa, pelo silêncio ou por erro. */
  onEnd: () => void
  onError: (message: string) => void
}

/** Silêncio que encerra o ditado sozinho, para o microfone não ficar ligado se a pessoa esquecer. */
const SILENCE_LIMIT_MS = 60_000
/** Rodada vazia mais curta que isso é o reconhecedor falhando, não silêncio. */
const BROKEN_ROUND_MS = 500

/**
 * Ciclo do microfone: uma frase por rodada, religando sozinho até a pessoa encerrar. No modo
 * contínuo o Chrome do Android manda cada trecho novo com tudo o que já tinha sido dito, e o texto
 * sai repetido; com rodadas, cada frase nova só substitui a versão anterior dela.
 */
function dictationEngine(initial: Handlers, setListening: (on: boolean) => void, setSpeaking: (on: boolean) => void) {
  let handlers = initial
  let current: Recognition | null = null
  let retry: ReturnType<typeof setTimeout> | undefined
  // Ditado em andamento: se a pessoa ainda quer ouvir, frases fechadas, última fala e falhas seguidas.
  let wanted = false
  let said = ''
  let heardAt = 0
  let failures = 0

  function finish() {
    clearTimeout(retry)
    current = null
    wanted = false
    setListening(false)
    setSpeaking(false)
    handlers.onEnd()
  }

  function giveUp() {
    handlers.onError('O microfone desligou. Toque nele para continuar.')
    finish()
  }

  /** Abre uma rodada; false se o navegador não deixou ligar o microfone. */
  function listen(): boolean {
    if (!Recognizer) return false
    const rec = new Recognizer()
    rec.lang = 'pt-BR'
    rec.continuous = false
    rec.interimResults = true
    const opened = performance.now()
    let phrase = ''
    rec.onresult = (e) => {
      heardAt = performance.now()
      // O último resultado é a versão mais nova da frase, mesmo quando o Android repete os anteriores.
      phrase = e.results.item(e.results.length - 1).item(0).transcript.trim()
      handlers.onText(join(said, phrase))
    }
    rec.onspeechstart = () => {
      heardAt = performance.now()
      setSpeaking(true)
    }
    rec.onspeechend = () => setSpeaking(false)
    rec.onerror = (e) => {
      // Silêncio e falhas passageiras não encerram: a rodada termina e a próxima continua ouvindo.
      const message = ERRORS[e.error]
      if (!message) return
      wanted = false
      handlers.onError(message)
    }
    rec.onend = () => {
      current = null
      said = join(said, phrase)
      setSpeaking(false)
      if (!wanted) return finish()
      const now = performance.now()
      if (now - heardAt >= SILENCE_LIMIT_MS) {
        if (!said) handlers.onError('Não ouvi nada. Toque no microfone e fale.')
        return finish()
      }
      // Pausa para pensar não desliga: a próxima rodada continua ouvindo. Rodada vazia e curtíssima
      // é o reconhecedor falhando (ex.: ainda ocupado com a anterior): tenta de novo com folga,
      // poucas vezes, para não virar um laço.
      const broken = !phrase && now - opened < BROKEN_ROUND_MS
      failures = broken ? failures + 1 : 0
      if (failures > 3) return giveUp()
      if (!broken) {
        if (!listen()) giveUp()
        return
      }
      retry = setTimeout(() => {
        if (wanted && !listen()) giveUp()
      }, 300 * failures)
    }
    try {
      rec.start()
    } catch {
      return false
    }
    current = rec
    return true
  }

  function start() {
    said = ''
    wanted = true
    heardAt = performance.now()
    failures = 0
    if (listen()) return setListening(true)
    handlers.onError('Não deu para ligar o microfone.')
    finish()
  }

  /** Encerra o ditado; `now` desliga sem esperar o fim da frase. */
  function end(now: boolean) {
    if (!wanted) return
    wanted = false
    // Entre uma rodada e outra não há reconhecedor para esperar.
    if (!current) return finish()
    if (now) current.abort()
    else current.stop()
  }

  return {
    /** Troca os handlers a cada render, para os callbacks verem o estado mais novo do componente. */
    handle: (next: Handlers) => {
      handlers = next
    },
    // Enquanto a última frase fecha (`current` sem `wanted`), outro toque espera.
    toggle: () => (wanted ? end(false) : !current && start()),
    stop: () => end(false),
    cancel: () => end(true),
  }
}

// ---------------------------------------------------------------------------
// Sem ditado no navegador (Firefox): grava e o PC transcreve com o Whisper (server/src/transcribe.ts)
// ---------------------------------------------------------------------------

/** Gravação mais longa aceita; o PC recusa acima de ~10 min. */
const MAX_RECORDING_MS = 5 * 60_000
const WHISPER_RATE = 16_000
// Volume (RMS) que nenhum trecho de 50 ms passou: só chiado do microfone. Fala fica bem acima de 0,02.
const SILENCE_RMS = 0.008

/** Volume do trecho de 50 ms mais alto. */
function loudest(samples: Float32Array, rate: number): number {
  const size = Math.round(rate * 0.05)
  let max = 0
  for (let start = 0; start < samples.length; start += size) {
    let sum = 0
    const end = Math.min(samples.length, start + size)
    for (let i = start; i < end; i++) sum += samples[i]! * samples[i]!
    max = Math.max(max, Math.sqrt(sum / Math.max(1, end - start)))
  }
  return max
}

/** Áudio gravado (webm ou ogg com opus) em WAV mono de 16 kHz, o que o Whisper lê; `null` se for só silêncio. */
async function toWav(blob: Blob): Promise<Blob | null> {
  // Decodificar num contexto de 16 kHz já reamostra.
  const decoded = await new OfflineAudioContext(1, 1, WHISPER_RATE).decodeAudioData(await blob.arrayBuffer())
  const mono = new Float32Array(decoded.length)
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const channel = decoded.getChannelData(c)
    for (let i = 0; i < mono.length; i++) mono[i]! += channel[i]! / decoded.numberOfChannels
  }
  if (loudest(mono, decoded.sampleRate) < SILENCE_RMS) return null
  const view = new DataView(new ArrayBuffer(44 + mono.length * 2))
  const ascii = (at: number, text: string) => [...text].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + mono.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, decoded.sampleRate, true)
  view.setUint32(28, decoded.sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, mono.length * 2, true)
  mono.forEach((x, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 0x7fff, true))
  return new Blob([view.buffer], { type: 'audio/wav' })
}

/**
 * Ditado gravado: o microfone grava até a pessoa parar, e aí o PC transcreve tudo de uma vez (o texto
 * não aparece enquanto se fala). Cancelar descarta a gravação.
 */
function recorderEngine(
  initial: Handlers,
  setListening: (on: boolean) => void,
  setTranscribing: (on: boolean) => void,
) {
  let handlers = initial
  let recorder: MediaRecorder | null = null
  let limit: ReturnType<typeof setTimeout> | undefined
  let busy = false
  // Cancelado (a pessoa digitou ou enviou): a gravação vai fora, sem transcrever.
  let discard = false

  function finish() {
    clearTimeout(limit)
    recorder = null
    busy = false
    setListening(false)
    setTranscribing(false)
    handlers.onEnd()
  }

  async function start() {
    busy = true
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    } catch (err) {
      const denied = err instanceof DOMException && err.name === 'NotAllowedError'
      handlers.onError(denied ? ERRORS['not-allowed']! : ERRORS['audio-capture']!)
      return finish()
    }
    const rec = new MediaRecorder(stream)
    const chunks: Blob[] = []
    discard = false
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      setListening(false)
      if (discard || !chunks.length) return finish()
      setTranscribing(true)
      try {
        const wav = await toWav(new Blob(chunks, { type: rec.mimeType }))
        // Só silêncio: nem ocupa o PC.
        const { text } = wav ? await api.transcribe(await blobToBase64(wav)) : { text: '' }
        if (text) handlers.onTranscript(text)
        else handlers.onError('Não ouvi nada. Toque no microfone e fale.')
      } catch (err) {
        handlers.onError(errorMessage(err))
      }
      finish()
    }
    rec.start()
    recorder = rec
    setListening(true)
    limit = setTimeout(() => stop(), MAX_RECORDING_MS)
  }

  function stop() {
    if (recorder?.state === 'recording') recorder.stop()
  }

  return {
    handle: (next: Handlers) => {
      handlers = next
    },
    // Gravando, para e transcreve; transcrevendo, espera.
    toggle: () => (recorder ? stop() : !busy && void start()),
    stop,
    cancel: () => {
      if (!recorder) return
      discard = true
      stop()
    },
  }
}

/**
 * Ditado: pelo reconhecimento de voz do navegador (no Android, o mesmo do Google que o Gboard usa),
 * com o texto aparecendo enquanto se fala; sem ele (Firefox), gravando para o Whisper do PC.
 */
export function useDictation(handlers: Handlers) {
  const [listening, setListening] = useState(false)
  // O reconhecedor detectou fala agora (dá o ritmo das ondas quando elas não podem ler o microfone).
  const [speaking, setSpeaking] = useState(false)
  // Gravação parada, esperando o PC transcrever.
  const [transcribing, setTranscribing] = useState(false)
  const [engine] = useState(() =>
    liveDictation ? dictationEngine(handlers, setListening, setSpeaking) : recorderEngine(handlers, setListening, setTranscribing),
  )
  useEffect(() => {
    engine.handle(handlers)
  })

  // Mandar o app para segundo plano ou sair da tela desliga o microfone.
  useEffect(() => {
    const hide = () => {
      if (document.hidden) engine.stop()
    }
    document.addEventListener('visibilitychange', hide)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      engine.cancel()
    }
  }, [engine])

  return {
    /** Ao vivo (o texto aparece enquanto se fala) ou gravado para o Whisper do PC. */
    live: liveDictation,
    listening,
    speaking,
    transcribing,
    /** Liga o microfone ou, se já estiver ouvindo, termina e mantém o que foi ouvido. */
    toggle: engine.toggle,
    /** Desliga na hora, sem esperar o fim da frase (ex.: a pessoa começou a digitar). */
    cancel: engine.cancel,
  }
}
