/*
 * A cena Ondas, como o papel de parede do app (web/src/components/wallpaper): linhas onduladas na
 * diagonal, desenhadas numa camada pequena e lidas célula por célula, que viram caracteres (`.` nas
 * bordas, `#` no meio). O ponteiro afasta as linhas e acende um pouco em volta dele.
 */

const Cena = (() => {
  const TAU = Math.PI * 2
  const RAMP = '.:-~=+*#'
  const CELL = { w: 9, h: 14 }
  const SS = 3
  const LEVELS = 12
  const LOOK = {
    light: { backdrop: '#f4f4f4', ink: [24, 24, 24], alpha: [0.12, 0.45] },
    dark: { backdrop: '#121212', ink: [235, 235, 235], alpha: [0.16, 0.55] },
  }
  const between = (a, b) => a + Math.random() * (b - a)
  const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
  const flick = (i, j, s) => {
    let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 2246822519)
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }

  let canvas, ctx, oc, ox
  let W = 0, H = 0, dpr = 1, cols = 0, rows = 0, k = 1
  let bands = []
  let atlas = null
  let drawn = new Int16Array(0)
  let xs = [], ys = []
  let dark = false
  let mouse = null
  let raf = 0
  let last = 0
  let still = false
  let t0 = performance.now()

  function makeBands() {
    const base = between(0.35, 0.8)
    const diag = Math.hypot(W, H)
    const spacing = 150 * k
    const count = Math.max(4, Math.round(diag / spacing))
    bands = Array.from({ length: count }, (_, n) => {
      const cross = Math.random() < 0.2
      return {
        angle: base + (cross ? between(0.5, 0.8) * (Math.random() < 0.5 ? -1 : 1) : between(-0.15, 0.15)),
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
  }

  function scene(g, t) {
    const cx = W / 2
    const cy = H / 2
    const R = 170 * k
    const diag = Math.hypot(W, H)
    const step = 10 * k
    g.lineCap = 'round'
    g.lineJoin = 'round'
    for (const b of bands) {
      const ux = Math.cos(b.angle)
      const uy = Math.sin(b.angle)
      const nx = -uy
      const ny = ux
      const half = diag / 2 + b.amp
      g.beginPath()
      for (let s = -half; s <= half; s += step) {
        let d = b.offset + b.amp * Math.sin((s / b.wave) * TAU + t * b.speed + b.phase) + b.amp2 * Math.sin((s / b.wave2) * TAU - t * b.speed2 + b.phase2)
        let x = cx + ux * s + nx * d
        let y = cy + uy * s + ny * d
        if (mouse) {
          const dx = x - mouse.x
          const dy = y - mouse.y
          const dist = Math.hypot(dx, dy)
          if (dist < R) {
            const side = Math.max(-1, Math.min(1, (dx * nx + dy * ny) / (R * 0.3)))
            d += side * (1 - dist / R) ** 2 * R * 0.45
            x = cx + ux * s + nx * d
            y = cy + uy * s + ny * d
          }
        }
        if (s === -half) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      const live = 0.65 + 0.35 * Math.sin(t * b.breath * TAU + b.breathPhase)
      for (const [w, a] of [[2.2, 0.22], [1.3, 0.4], [0.5, 0.9]]) {
        g.lineWidth = b.width * w
        g.strokeStyle = `rgba(255,255,255,${a * live})`
        g.stroke()
      }
    }
  }

  function buildAtlas() {
    const look = dark ? LOOK.dark : LOOK.light
    const gw = Math.ceil(CELL.w * dpr)
    const gh = Math.ceil(CELL.h * dpr)
    const c = document.createElement('canvas')
    c.width = RAMP.length * gw
    c.height = LEVELS * gh
    const g = c.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.font = `600 ${Math.round(CELL.h * 0.7)}px 'Cascadia Code Variable', ui-monospace, monospace`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    const [lo, hi] = look.alpha
    for (let lv = 0; lv < LEVELS; lv++) {
      g.fillStyle = `rgba(${look.ink.join(',')},${lo + ((hi - lo) * (lv + 0.5)) / LEVELS})`
      for (let ch = 0; ch < RAMP.length; ch++) g.fillText(RAMP[ch], (ch * gw) / dpr + CELL.w / 2, (lv * gh) / dpr + CELL.h / 2 + 1)
    }
    atlas = c
  }

  function clear() {
    const look = dark ? LOOK.dark : LOOK.light
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = look.backdrop
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    drawn.fill(-1)
  }

  function resize() {
    W = innerWidth
    H = innerHeight
    // Num iframe a página pode nascer sem tamanho: a cena espera o primeiro `resize` de verdade.
    if (!W || !H) {
      cols = rows = 0
      return
    }
    dpr = Math.min(devicePixelRatio || 1, 2)
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    k = clamp(Math.min(W, H) / 900, 0.55, 1.3)
    cols = Math.ceil(W / CELL.w)
    rows = Math.ceil(H / CELL.h)
    oc.width = cols * SS
    oc.height = rows * SS
    drawn = new Int16Array(cols * rows)
    xs = Array.from({ length: cols + 1 }, (_, i) => Math.round(i * CELL.w * dpr))
    ys = Array.from({ length: rows + 1 }, (_, j) => Math.round(j * CELL.h * dpr))
    makeBands()
    buildAtlas()
    clear()
    frame(performance.now(), true)
  }

  function frame(now, force = false) {
    if (!cols || !rows || !atlas) return
    const t = (now - t0) / 1000
    ox.setTransform(1, 0, 0, 1, 0, 0)
    ox.clearRect(0, 0, oc.width, oc.height)
    ox.setTransform(SS / CELL.w, 0, 0, SS / CELL.h, 0, 0)
    scene(ox, still ? 0 : t)
    const d = ox.getImageData(0, 0, oc.width, oc.height).data
    const rw = oc.width * 4
    const n = SS * SS
    const top = RAMP.length - 1
    const slot = still ? 0 : Math.floor(t * 1.5)
    const lantern = mouse ? 150 : 0
    const look = dark ? LOOK.dark : LOOK.light
    const gw = Math.ceil(CELL.w * dpr)
    const gh = Math.ceil(CELL.h * dpr)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = look.backdrop
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        let a = 0
        for (let v = 0; v < SS; v++) for (let u = 0, p = (j * SS + v) * rw + i * SS * 4; u < SS; u++, p += 4) a += d[p + 3]
        a /= 255 * n
        const cx = i * CELL.w + CELL.w / 2
        const cy = j * CELL.h + CELL.h / 2
        const near = lantern ? clamp(1 - Math.hypot(cx - mouse.x, cy - mouse.y) / lantern) : 0
        const lit = near * near * 0.45
        const val = a > 0.04 ? clamp(a + lit * 0.6) : lit * 0.7
        let glyph = -1
        if (val >= 0.05) {
          const c = clamp(Math.floor(val * top + (flick(i, j, slot) - 0.5) * 1.1), 0, top)
          glyph = Math.min(LEVELS - 1, Math.floor(val * LEVELS)) * RAMP.length + c
        }
        const k2 = j * cols + i
        const before = drawn[k2]
        if (glyph === before && !force) continue
        drawn[k2] = glyph
        const x = xs[i]
        const y = ys[j]
        ctx.fillRect(x, y, xs[i + 1] - x, ys[j + 1] - y)
        if (glyph !== -1) ctx.drawImage(atlas, (glyph % RAMP.length) * gw, ((glyph / RAMP.length) | 0) * gh, gw, gh, x, y, gw, gh)
      }
  }

  function loop(now) {
    raf = requestAnimationFrame(loop)
    // 30 quadros por segundo bastam para a onda, e a cena não disputa com as janelas.
    if (now - last < 33) return
    last = now
    frame(now)
  }

  function play() {
    cancelAnimationFrame(raf)
    if (still || document.hidden) {
      frame(performance.now())
      return
    }
    raf = requestAnimationFrame(loop)
  }

  return {
    mount(el) {
      canvas = el
      ctx = canvas.getContext('2d')
      oc = document.createElement('canvas')
      ox = oc.getContext('2d', { willReadFrequently: true })
      still = matchMedia('(prefers-reduced-motion: reduce)').matches
      addEventListener('resize', () => resize())
      addEventListener('pointermove', (e) => {
        mouse = { x: e.clientX, y: e.clientY }
        if (still) frame(performance.now())
      })
      document.documentElement.addEventListener('pointerleave', () => (mouse = null))
      document.addEventListener('visibilitychange', play)
      resize()
      play()
    },
    setDark(on) {
      dark = on
      if (!canvas) return
      buildAtlas()
      clear()
      frame(performance.now(), true)
    },
    setOn(on) {
      canvas.style.opacity = on ? '1' : '0'
      if (on) play()
      else cancelAnimationFrame(raf)
    },
    /** Parada: um quadro só, redesenhado quando o ponteiro passa. */
    setStill(on) {
      still = on || matchMedia('(prefers-reduced-motion: reduce)').matches
      play()
    },
    /** De novo, com outras linhas: a cena nasce diferente a cada vez, como no app. */
    reroll() {
      makeBands()
      clear()
      frame(performance.now(), true)
    },
  }
})()
