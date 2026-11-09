/** O que as telas do modo coding (passos e código) usam para saber se algo acabou de acontecer. */
export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

// Até quanto tempo depois de começar uma ferramenta ainda conta como recém-chegada. A conversa aberta no
// PC chega pelo histórico relido a cada 4 s, sem a hora de chegada ao vivo: vale a hora do transcript.
export const FRESH_MS = 60_000

export const isRecent = (from: number | undefined): boolean => Boolean(from) && Date.now() - from! < FRESH_MS
