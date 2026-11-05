/*
 * O claudinho, como no app (web/src/lib/claudinho.ts e components/claudinho.tsx): a mesma semente dá
 * o mesmo bichinho, com a mesma forma, cor, olhos e nome. Aqui sai como texto SVG.
 */

const CLAUDINHO_COLORS = ['#2fc677', '#ff4fa3', '#8b5cf6', '#ff5a5a', '#f5a524', '#3aa8ff', '#14b8a6', '#ff7a3d', '#6366f1', '#d946ef']
const SHAPES = ['square', 'wide', 'circle', 'tall', 'hex', 'drop', 'arch']
const EYES = ['oval', 'oval', 'dot', 'big', 'happy', 'sleepy', 'focused', 'wink']
const FACE = {
  square: { y: 15, gap: 9 },
  wide: { y: 16, gap: 11 },
  circle: { y: 15, gap: 9 },
  tall: { y: 13, gap: 8 },
  hex: { y: 15.5, gap: 9 },
  drop: { y: 19.5, gap: 9 },
  arch: { y: 15, gap: 9 },
}
const NAMES = [
  'Vita', 'Cloe', 'Malu', 'Nina', 'Theo', 'Iris', 'Bia', 'Duda', 'Nico', 'Tito', 'Lila', 'Lulu', 'Mimi', 'Juju',
  'Kiko', 'Bento', 'Caio', 'Davi', 'Gael', 'Ivo', 'Joca', 'Leo', 'Luca', 'Lino', 'Mila', 'Nara', 'Noa', 'Pipa',
  'Pipo', 'Rafa', 'Remi', 'Rita', 'Sami', 'Sara', 'Tati', 'Teca', 'Tobi', 'Vini', 'Yuri', 'Zeca', 'Zoe', 'Zuza',
  'Cacau', 'Dora', 'Edu', 'Fifi', 'Gabi', 'Guto', 'Bubi', 'Jade', 'Juca', 'Kika', 'Lola', 'Mabel', 'Nilo', 'Nuno',
  'Otto', 'Paco', 'Pepe', 'Rubi', 'Sofi', 'Yago', 'Zara', 'Yoshi', 'Momo', 'Nemo', 'Lumi', 'Nami', 'Taro', 'Hana',
  'Koda', 'Suki', 'Miko', 'Riko', 'Tofu', 'Pingo', 'Bingo', 'Dengo', 'Pudim', 'Mochi', 'Caju', 'Kiwi', 'Figo',
  'Lupi', 'Dudu', 'Neno', 'Tuca', 'Babi', 'Didi', 'Gigi', 'Lelo', 'Mano', 'Nana', 'Vivi', 'Nino', 'Tilo', 'Vavá',
  'Zico', 'Lori', 'Bolo', 'Biju', 'Chico', 'Dino', 'Faro', 'Kuma', 'Lalo', 'Mira', 'Tina', 'Ozzy', 'Pita', 'Tuti',
]

/** FNV-1a: o texto vira um número, sempre o mesmo. */
function fnv(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Mulberry32: uma sequência de sorteios a partir do número. */
function mulberry(seed) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const looks = new Map()

function lookOf(seed) {
  const hit = looks.get(seed)
  if (hit) return hit
  const next = mulberry(fnv(seed))
  const pick = (list) => list[Math.floor(next() * list.length)]
  const shape = pick(SHAPES)
  const face = FACE[shape]
  const eyeScale = 0.85 + next() * 0.3
  const look = {
    shape,
    color: pick(CLAUDINHO_COLORS),
    eyes: pick(EYES),
    eyeScale,
    gap: Math.max(face.gap - next() * 2.5, 8.2 * eyeScale),
    eyeY: face.y + (next() - 0.5) * 1.5,
    tilt: next() < 0.33 ? (next() - 0.5) * 16 : 0,
  }
  looks.set(seed, look)
  return look
}

const phaseOf = (seed) => (fnv(`${seed}:fase`) % 1000) / 1000
const nameOf = (seed) => NAMES[fnv(`${seed}:nome`) % NAMES.length]

function body(look) {
  const c = look.color
  switch (look.shape) {
    case 'square':
      return `<rect x="4" y="4" width="24" height="24" rx="8" fill="${c}"/>`
    case 'wide':
      return `<rect x="2" y="7" width="28" height="18" rx="9" fill="${c}"/>`
    case 'circle':
      return `<circle cx="16" cy="16" r="13" fill="${c}"/>`
    case 'tall':
      return `<rect x="6" y="2" width="20" height="28" rx="9" fill="${c}"/>`
    case 'hex':
      return `<polygon points="9.5,5.5 22.5,5.5 28.5,16 22.5,26.5 9.5,26.5 3.5,16" fill="${c}" stroke="${c}" stroke-width="5" stroke-linejoin="round"/>`
    case 'drop':
      return `<polygon points="16,8 25.5,25 6.5,25" fill="${c}" stroke="${c}" stroke-width="10" stroke-linejoin="round"/>`
    case 'arch':
      return `<path d="M5 27V15a11 11 0 0 1 22 0v12z" fill="${c}" stroke="${c}" stroke-width="3" stroke-linejoin="round"/>`
  }
}

function eye(x, y, s, kind, side) {
  const arc = `<path d="M${x - 2.5 * s} ${y + 1.3 * s}Q${x} ${y - 2.8 * s} ${x + 2.5 * s} ${y + 1.3 * s}" fill="none" stroke="#fff" stroke-width="${2.2 * s}" stroke-linecap="round"/>`
  switch (kind) {
    case 'oval':
      return `<ellipse cx="${x}" cy="${y}" rx="${2.4 * s}" ry="${3.4 * s}" fill="#fff"/>`
    case 'dot':
      return `<circle cx="${x}" cy="${y}" r="${2.2 * s}" fill="#fff"/>`
    case 'big':
      return `<circle cx="${x}" cy="${y}" r="${3.3 * s}" fill="#fff"/>`
    case 'happy':
      return arc
    case 'sleepy':
      return `<path d="M${x - 2.8 * s} ${y}a${2.8 * s} ${2.6 * s} 0 0 0 ${5.6 * s} 0z" fill="#fff"/>`
    case 'focused':
      return `<ellipse cx="${x}" cy="${y}" rx="${2.4 * s}" ry="${3.2 * s}" fill="#fff" transform="rotate(${-side * 20} ${x} ${y})"/>`
    case 'wink':
      return side < 0 ? `<ellipse cx="${x}" cy="${y}" rx="${2.4 * s}" ry="${3.4 * s}" fill="#fff"/>` : arc
  }
}

/** Os traços por cima do corpo ganham um contorno da cor do fundo, para aparecerem em 16 px. */
const outlined = (inner, fill = '', cls = '') =>
  `<g fill="var(--background)" stroke="var(--background)" stroke-width="2.5" stroke-linejoin="round">${inner}</g><g ${fill ? `fill="${fill}"` : ''} class="${cls}">${inner}</g>`

function bubble(kind) {
  const shape = '<path d="M22.5 -1.8h5a4.5 4.5 0 0 1 0 9h-5a4.5 4.5 0 0 1 0 -9z"/><path d="M20.2 5.6L18.9 8.9L23.6 7z"/>'
  if (kind === 'dots')
    return `<g>${outlined(shape, '', 'fill-sky')}<g fill="#fff" class="claudinho-typing"><circle cx="21.6" cy="2.7" r="1.3"/><circle cx="25" cy="2.7" r="1.3"/><circle cx="28.4" cy="2.7" r="1.3"/></g></g>`
  return `<g class="claudinho-nudge">${outlined(shape, '', 'fill-amber')}<path d="M25 0.4v3.2" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/><circle cx="25" cy="5.7" r="1.1" fill="#fff"/></g>`
}

function thinkingHand(look) {
  const x = 16 - look.gap * 0.15
  const chin = Math.min(look.eyeY + 6 * look.eyeScale, 24)
  return `<g class="claudinho-hmm">${outlined(`<rect x="${x - 5}" y="${chin + 2.6}" width="6.6" height="5.4" rx="2.5"/><rect x="${x - 1.5}" y="${chin}" width="2.5" height="5" rx="1.25"/>`, look.color)}</g>`
}

const brow = (x, y, s) =>
  `<path d="M${x - 2.6 * s} ${y - 4.6 * s}Q${x - 0.2 * s} ${y - 7 * s} ${x + 2.6 * s} ${y - 5.4 * s}" fill="none" stroke="#fff" stroke-width="${1.5 * s}" stroke-linecap="round"/>`

const thumbsUp = (color) =>
  `<g class="claudinho-thumb">${outlined('<rect x="23.4" y="25" width="8" height="6" rx="2.6"/><rect x="25.1" y="19.9" width="3" height="7.2" rx="1.5"/>', color)}<path d="M27.1 27.1h3.6M27.1 29h3.6" stroke="var(--background)" stroke-width="0.8" stroke-linecap="round" opacity="0.55"/></g>`

/**
 * O claudinho. `state`: 'running' pisca e (com `status`) mostra o balão "…"; 'waiting' olha para cima e
 * mostra o "!"; `pose`: 'think' (a mão no queixo) ou 'done' (o joinha).
 */
function claudinho(seed, { size = 28, state, status = false, pose, cls = '', name } = {}) {
  const look = lookOf(seed)
  const running = state === 'running'
  const waiting = state === 'waiting'
  const bub = status && !pose ? (waiting ? 'alert' : running ? 'dots' : '') : ''
  const half = look.gap / 2
  const eyes = pose === 'done' ? 'happy' : look.eyes
  const lift = waiting ? 'translate(0 -1.6)' : pose === 'think' ? 'translate(0.9 -1.3)' : ''
  const blink = running ? `class="claudinho-blink" style="animation-delay:${(-phaseOf(seed) * 4).toFixed(2)}s"` : ''
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" class="claudinho ${cls}" ${name ? `role="img" aria-label="${name}"` : 'aria-hidden="true"'}>${name ? `<title>${name}</title>` : ''}<g class="${pose === 'done' ? 'claudinho-cheer' : ''}"><g ${look.tilt ? `transform="rotate(${look.tilt.toFixed(1)} 16 16)"` : ''}>${body(look)}<g ${lift ? `transform="${lift}"` : ''}><g ${blink}>${eye(16 - half, look.eyeY, look.eyeScale, eyes, -1)}${eye(16 + half, look.eyeY, look.eyeScale, eyes, 1)}</g>${pose === 'think' ? brow(16 - half, look.eyeY, look.eyeScale) : ''}</g>${pose === 'think' ? thinkingHand(look) : ''}</g></g>${pose === 'done' ? thumbsUp(look.color) : ''}${bub ? bubble(bub) : ''}</svg>`
}
