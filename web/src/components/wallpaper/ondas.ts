import { between, type Theme } from './engine'

const TAU = Math.PI * 2

/**
 * Linhas onduladas que atravessam a tela na diagonal, sorteadas a cada vez que a cena nasce: cada uma
 * com a sua curva, a sua largura e o seu passo. São traços largos e suaves na camada da cena; a grade
 * faz deles faixas de caracteres, densos no meio (`#`) e ralos nas bordas (`.`). Algumas cruzam as
 * outras, cada uma respira devagar, e o ponteiro as afasta como a mão numa cortina.
 */
export const ondas: Theme = {
  id: 'ondas',
  name: 'Ondas',
  hint: 'Linhas onduladas e aleatórias, que se afastam do ponteiro.',
  cell: { w: 9, h: 14 },
  ramp: '.:-~=+*#',
  style: 'glyphs',
  fps: 30,
  veil: false,
  look: (dark) =>
    dark
      ? { backdrop: '#121212', ink: [235, 235, 235], alpha: [0.16, 0.55] }
      : { backdrop: '#f4f4f4', ink: [24, 24, 24], alpha: [0.12, 0.45] },
  create({ W, H, k }) {
    // A direção da maioria; umas poucas cruzam as outras, num ângulo raso, como fios trançados.
    const base = between(0.35, 0.8)
    const diag = Math.hypot(W, H)
    const spacing = 150 * k
    const count = Math.max(4, Math.round(diag / spacing))
    const bands = Array.from({ length: count }, (_, n) => {
      const cross = Math.random() < 0.2
      return {
        angle: base + (cross ? between(0.5, 0.8) * (Math.random() < 0.5 ? -1 : 1) : between(-0.15, 0.15)),
        // Onde a faixa passa, medido de um lado ao outro da tela, com um pouco de folga para as pontas.
        offset: (n / (count - 1 || 1) - 0.5) * diag * 1.05 + between(-0.3, 0.3) * spacing,
        width: between(20, 44) * k,
        amp: between(40, 95) * k,
        wave: between(560, 1150) * k,
        speed: between(0.2, 0.45) * (Math.random() < 0.5 ? -1 : 1),
        phase: Math.random() * TAU,
        amp2: between(6, 18) * k,
        wave2: between(260, 480) * k,
        speed2: between(0.3, 0.7),
        phase2: Math.random() * TAU,
        breath: between(0.05, 0.14),
        breathPhase: Math.random() * TAU,
      }
    })
    const step = 10 * k

    return {
      scene(g, { t, mouse }) {
        const cx = W / 2
        const cy = H / 2
        const R = 170 * k
        g.lineCap = 'round'
        g.lineJoin = 'round'
        for (const b of bands) {
          const ux = Math.cos(b.angle)
          const uy = Math.sin(b.angle)
          // A normal: para onde a onda sobe e desce.
          const nx = -uy
          const ny = ux
          const half = diag / 2 + b.amp
          g.beginPath()
          for (let s = -half; s <= half; s += step) {
            let d =
              b.offset +
              b.amp * Math.sin((s / b.wave) * TAU + t * b.speed + b.phase) +
              b.amp2 * Math.sin((s / b.wave2) * TAU - t * b.speed2 + b.phase2)
            let x = cx + ux * s + nx * d
            let y = cy + uy * s + ny * d
            if (mouse) {
              // O ponteiro empurra a linha para o lado dela em que ela já está.
              const dx = x - mouse.x
              const dy = y - mouse.y
              const dist = Math.hypot(dx, dy)
              if (dist < R) {
                // Contínuo dos dois lados: um sinal seco dobraria a linha bem embaixo do ponteiro.
                const side = Math.max(-1, Math.min(1, (dx * nx + dy * ny) / (R * 0.3)))
                d += side * (1 - dist / R) ** 2 * R * 0.45
                x = cx + ux * s + nx * d
                y = cy + uy * s + ny * d
              }
            }
            if (s === -half) g.moveTo(x, y)
            else g.lineTo(x, y)
          }
          // Três passadas, da mais larga e fraca à mais estreita e forte: é o degradê do meio para a borda.
          const live = 0.65 + 0.35 * Math.sin(t * b.breath * TAU + b.breathPhase)
          for (const [w, a] of [
            [2.2, 0.22],
            [1.3, 0.4],
            [0.5, 0.9],
          ] as const) {
            g.lineWidth = b.width * w
            g.strokeStyle = `rgba(255,255,255,${a * live})`
            g.stroke()
          }
        }
      },
    }
  },
}
