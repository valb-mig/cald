import { useStore } from './store'

/**
 * O título da aba avisa quando algum Claude está esperando sua resposta — uma pergunta ou uma aprovação, aqui
 * ou no PC, em qualquer máquina: "(2) Esperando resposta · edit.r". Dá para ver de outra aba, sem
 * depender do som nem da notificação. É o mesmo sinal do som de atenção (ver lib/sounds.ts).
 */
let started = false

export function startTitle(): void {
  if (started) return
  started = true
  // O nome do site, como está no index.html.
  const base = document.title
  // No canal dev o nome ganha " dev": a janela e a aba se distinguem da versão pública. A build de teste
  // de uma branch leva o nome dela, para a janela não se confundir com a de sempre na barra do sistema.
  const name = () => {
    const { channel, test } = useStore.getState()
    if (test) return `${base} teste${__BUILD_GIT__ ? ` · ${__BUILD_GIT__.branch}` : ''}`
    return channel === 'dev' ? `${base} dev` : base
  }
  const show = (n: number) => {
    const title = n ? `(${n}) Esperando resposta · ${name()}` : name()
    if (document.title !== title) document.title = title
  }
  const asking = () => useStore.getState().catalog.filter((c) => c.state === 'waiting').length
  show(asking())
  useStore.subscribe((s, prev) => {
    if (s.catalog !== prev.catalog || s.channel !== prev.channel || s.test !== prev.test) show(asking())
  })
}
