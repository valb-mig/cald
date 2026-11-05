/*
 * cald os: um Linux no jeito do cald. A alça à esquerda (apps, medidas, hora), as janelas como ilhas
 * sobre a cena Ondas, e o Claude como parte do sistema: ele trabalha em segundo plano, pede licença
 * em âmbar e avisa quando termina. Tudo o que muda tem volta.
 */

const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const params = new URLSearchParams(location.search)

// A página roda isolada (sem origem própria): o localStorage pode não existir.
const saved = {
  get(k) {
    try {
      return localStorage.getItem(`cald-os:${k}`)
    } catch {
      return null
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`cald-os:${k}`, v)
    } catch {}
  },
}

function bytes(n) {
  const f = (v, d) => v.toLocaleString('pt-BR', { maximumFractionDigits: d })
  if (n >= 1e9) return `${f(n / 1e9, 1)} GB`
  if (n >= 1e6) return `${f(n / 1e6, 0)} MB`
  return `${f(n / 1e3, 0)} KB`
}
const severity = (p) => (p >= 90 ? 'critical' : p >= 70 ? 'warning' : 'normal')
const PROJECT_COLORS = ['#3aa8ff', '#2fc677', '#8b5cf6', '#ff7a3d', '#ff4fa3', '#14b8a6', '#f5a524', '#6366f1', '#ff5a5a', '#d946ef']
function projectColor(name) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) | 0
  return PROJECT_COLORS[Math.abs(h) % PROJECT_COLORS.length]
}
const initial = (name) => esc((/[\p{L}\p{N}]/u.exec(name)?.[0] ?? '?').toUpperCase())
const pmark = (name) => `<span class="pmark" style="background:${projectColor(name)}">${initial(name)}</span>`
const bigMark = (name) => `<span class="pmark" style="width:40px;height:40px;border-radius:10px;font-size:18px;background:${projectColor(name)}">${initial(name)}</span>`

/* ---------------------------------------------------------------- Estado */

const DISK_TOTAL = 256e9
const ME = 'valb'
const CHAT_SEED = 'conversa:liberar-espaco'
const CLEANUP = [
  { icon: 'hard-drive', label: 'Imagens Docker sem uso', size: 34.1e9, cmd: 'docker image prune -a' },
  { icon: 'folder', label: 'Cache órfão do pnpm', size: 21.1e9, cmd: 'pnpm store prune' },
  { icon: 'download', label: '5 downloads repetidos', size: 3.2e9, cmd: 'gio trash ~/Downloads/{…}' },
]
const CLEANUP_TOTAL = CLEANUP.reduce((a, c) => a + c.size, 0)

const S = {
  theme: saved.get('tema') ?? 'sistema',
  scene: true,
  calm: false,
  wifi: true,
  bt: false,
  dnd: false,
  volume: 64,
  bright: 80,
  output: 'alto-falantes',
  sounds: true,
  power: 'equilibrado',
  sleep: '15',
  net: 'casa-5g',
  diskUsed: 233e9,
  cpu: 18,
  ram: 61,
  battery: 82,
  locked: true,
  claude: { phase: 'waiting', started: 0, step: '', cleaned: false, run: 0 },
  downloads: [
    { name: 'archlinux-2026.11.01-x86_64.iso', size: 1.4e9, icon: 'file-archive', junk: true, when: '4 dias' },
    { name: 'node_modules-backup.tar.gz', size: 1.1e9, icon: 'file-archive', junk: true, when: '2 sem' },
    { name: 'gravacao-tela-0412.mp4', size: 460e6, icon: 'film', junk: true, when: '3 sem' },
    { name: 'Obsidian-1.9.4.AppImage', size: 120e6, icon: 'app-window', junk: true, when: '1 mês' },
    { name: 'Obsidian-1.9.4 (1).AppImage', size: 120e6, icon: 'app-window', junk: true, when: '1 mês' },
    { name: 'contrato-prestacao.pdf', size: 240e3, icon: 'file-text', when: 'ontem' },
    { name: 'fatura-outubro.pdf', size: 180e3, icon: 'file-text', when: '3 dias' },
    { name: 'ondas.png', size: 3.1e6, icon: 'image', when: '5 dias' },
    { name: 'notas-reuniao.md', size: 4e3, icon: 'file-code', when: 'hoje' },
  ],
  trash: [],
  projects: [
    { name: 'cald', branch: 'main', add: 12, del: 3, when: 'agora' },
    { name: 'warden', branch: 'feat/engine', when: '2 h' },
    { name: 'cordel.app', branch: 'main', when: 'ontem' },
    { name: 'zarb2', branch: 'develop', add: 4, del: 0, when: '3 dias' },
    { name: 'astro.valb-blog', branch: 'main', when: '1 sem' },
    { name: 'vscode-pocket-terminal', branch: 'main', when: '2 sem' },
  ],
  files: { view: 'downloads', sel: null, q: '', search: false },
  settings: { view: 'aparencia' },
  chats: [],
  chatTab: null,
  term: { tabs: [], tab: null, history: [], hi: -1 },
  web: { tabs: [{ id: 'w1', title: 'Nova aba', url: '' }], tab: 'w1' },
}
const diskPct = () => (S.diskUsed / DISK_TOTAL) * 100
let uid = 0
const nextId = (p) => `${p}${++uid}`

/* ---------------------------------------------------------------- Tema */

const mq = matchMedia('(prefers-color-scheme: dark)')
const isDark = () => S.theme === 'escuro' || (S.theme === 'sistema' && mq.matches)
function applyTheme() {
  const dark = isDark()
  document.documentElement.classList.toggle('dark', dark)
  Cena.setDark(dark)
}
function setTheme(mode) {
  S.theme = mode
  saved.set('tema', mode)
  applyTheme()
  refreshAll()
}
mq.addEventListener('change', () => S.theme === 'sistema' && applyTheme())

/* ---------------------------------------------------------------- Janelas */

const APPS = {
  claude: { title: 'Claude', glyph: () => claudeMark(20), layout: 'tabs' },
  files: { title: 'Arquivos', glyph: () => icon('folder', 20), layout: 'island' },
  term: { title: 'Terminal', glyph: () => icon('square-terminal', 20), layout: 'tabs' },
  web: { title: 'Navegador', glyph: () => icon('globe', 20), layout: 'tabs' },
  settings: { title: 'Ajustes', glyph: () => icon('settings-2', 20), layout: 'island' },
}
const RAIL_APPS = ['claude', 'files', 'term', 'web', 'settings']

const WM = {
  wins: new Map(),
  z: 0,
  focused: null,
  /** A faixa do alto fica para a cena e para a ilha do Claude: nenhuma janela sobe nela (no celular, a ilha vai para baixo). */
  get top() {
    return matchMedia('(max-width: 47.99rem)').matches ? 0 : 52
  },
  area() {
    const r = $('#area').getBoundingClientRect()
    return { w: r.width, h: r.height }
  },
  defaultRect(app) {
    const { w, h } = this.area()
    const top = this.top + 12
    const cw = Math.round(Math.min(520, Math.max(380, w * 0.36)))
    const claude = { x: 16, y: top, w: cw, h: h - top - 16 }
    const fx = claude.x + claude.w + 20
    const files = { x: fx, y: top, w: Math.min(680, w - fx - 28), h: Math.round((h - top) * 0.5) }
    const tx = fx + 72
    const ty = files.y + files.h - 28
    const center = (ww, hh) => ({ w: Math.min(ww, w - 32), h: Math.min(hh, h - top - 16), x: Math.max(16, (w - ww) / 2), y: Math.max(top, (h - hh) / 2) })
    switch (app) {
      case 'claude':
        return claude
      case 'files':
        return files
      case 'term':
        return { x: tx, y: ty, w: Math.min(660, w - tx - 16), h: h - ty - 16 }
      case 'web':
        return center(820, 560)
      case 'settings':
        return center(760, 540)
    }
  },
  open(app, opts = {}) {
    const existing = this.wins.get(app)
    if (existing) {
      if (existing.min) this.restore(existing)
      this.focus(existing)
      return existing
    }
    const r = this.defaultRect(app)
    const w = { app, ...r, max: false, min: false, prev: null, el: document.createElement('div') }
    w.el.className = `win${APPS[app].layout === 'island' ? ' island' : ''}`
    w.el.dataset.app = app
    w.el.setAttribute('role', 'dialog')
    w.el.setAttribute('aria-label', APPS[app].title)
    this.wins.set(app, w)
    this.place(w)
    $('#wins').append(w.el)
    renderWin(w)
    if (!opts.background) this.focus(w)
    else this.raise(w)
    renderRail()
    return w
  },
  place(w) {
    Object.assign(w.el.style, { left: `${w.x}px`, top: `${w.y}px`, width: `${w.w}px`, height: `${w.h}px` })
  },
  raise(w) {
    w.el.style.zIndex = ++this.z
  },
  focus(w) {
    if (!w) return
    this.raise(w)
    for (const o of this.wins.values()) o.el.classList.toggle('focused', o === w)
    this.focused = w
    renderRail()
    renderPulse()
  },
  topVisible(except) {
    return [...this.wins.values()].filter((o) => o !== except && !o.min).sort((a, b) => b.el.style.zIndex - a.el.style.zIndex)[0] ?? null
  },
  animate(w) {
    w.el.classList.add('animating')
    clearTimeout(w.anim)
    w.anim = setTimeout(() => w.el.classList.remove('animating'), 320)
  },
  toggleMax(w) {
    this.animate(w)
    if (w.max) {
      Object.assign(w, w.prev, { max: false })
    } else {
      const { w: aw, h: ah } = this.area()
      w.prev = { x: w.x, y: w.y, w: w.w, h: w.h }
      Object.assign(w, { x: 0, y: this.top, w: aw, h: ah - this.top, max: true })
    }
    this.place(w)
    renderWin(w, 'ctrls')
  },
  minimize(w) {
    w.el.classList.add('minimizing')
    setTimeout(() => {
      w.el.classList.remove('minimizing')
      w.el.classList.add('hidden')
    }, 230)
    w.min = true
    w.el.classList.remove('focused')
    if (this.focused === w) this.focused = null
    this.focus(this.topVisible(w))
    renderRail()
  },
  restore(w) {
    w.min = false
    w.el.classList.remove('hidden')
  },
  close(w) {
    w.el.classList.add('leaving')
    setTimeout(() => w.el.remove(), 180)
    this.wins.delete(w.app)
    if (this.focused === w) {
      this.focused = null
      this.focus(this.topVisible(w))
    }
    renderRail()
  },
  /** Lado a lado: a janela em foco à esquerda e a de baixo dela à direita. */
  tile() {
    const list = [...this.wins.values()].filter((o) => !o.min).sort((a, b) => b.el.style.zIndex - a.el.style.zIndex)
    const { w: aw, h: ah } = this.area()
    const gap = 10
    const half = (aw - gap) / 2
    list.slice(0, 2).forEach((o, i) => {
      this.animate(o)
      Object.assign(o, { x: i ? half + gap : 0, y: this.top, w: list.length > 1 ? half : aw, h: ah - this.top, max: false })
      this.place(o)
    })
    return list.length
  },
  fit() {
    const { w: aw, h: ah } = this.area()
    for (const o of this.wins.values()) {
      if (o.max) Object.assign(o, { y: this.top, w: aw, h: ah - this.top })
      o.w = Math.min(o.w, aw)
      o.h = Math.min(o.h, ah - this.top)
      o.x = Math.min(Math.max(o.x, 0), aw - 120)
      o.y = Math.min(Math.max(o.y, this.top), ah - 48)
      this.place(o)
    }
  },
}

// Arrastar pela barra das abas (ou pelo alto da lista, nas janelas em ilha); redimensionar pelo canto.
let drag = null
let swallowClick = false
document.addEventListener('pointerdown', (e) => {
  const winEl = e.target.closest('.win')
  if (!winEl) return
  const w = WM.wins.get(winEl.dataset.app)
  if (w && WM.focused !== w) WM.focus(w)
  if (e.button !== 0 || matchMedia('(max-width: 47.99rem)').matches) return
  const grip = e.target.closest('[data-grip]')
  const zone = e.target.closest('[data-drag]')
  if (!grip && (!zone || e.target.closest('input, textarea, .icon-btn, .nav-item, .btn, .x'))) return
  drag = { w, grip: !!grip, sx: e.clientX, sy: e.clientY, x: w.x, y: w.y, ww: w.w, hh: w.h, moved: false, id: e.pointerId }
})
document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return
  const dx = e.clientX - drag.sx
  const dy = e.clientY - drag.sy
  if (!drag.moved && Math.hypot(dx, dy) < 4) return
  const { w } = drag
  const area = WM.area()
  if (!drag.moved) {
    drag.moved = true
    document.body.style.cursor = drag.grip ? 'nwse-resize' : 'grabbing'
    document.body.style.userSelect = 'none'
    // Arrastar a janela cheia devolve o tamanho de antes, com o ponteiro no mesmo lugar dela.
    if (w.max && !drag.grip) {
      const ratio = (drag.sx - $('#area').getBoundingClientRect().left) / w.w
      Object.assign(w, w.prev, { max: false })
      drag.x = drag.sx - $('#area').getBoundingClientRect().left - w.w * ratio
      drag.y = WM.top
      renderWin(w, 'ctrls')
    }
  }
  if (drag.grip) {
    w.w = Math.max(352, Math.min(drag.ww + dx, area.w - w.x))
    w.h = Math.max(240, Math.min(drag.hh + dy, area.h - w.y))
  } else {
    w.x = Math.min(Math.max(drag.x + dx, -w.w + 120), area.w - 120)
    w.y = Math.min(Math.max(drag.y + dy, WM.top), area.h - 48)
  }
  WM.place(w)
})
const endDrag = () => {
  if (!drag) return
  if (drag.moved) swallowClick = true
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  drag = null
  setTimeout(() => (swallowClick = false), 0)
}
document.addEventListener('pointerup', endDrag)
document.addEventListener('pointercancel', endDrag)
document.addEventListener(
  'click',
  (e) => {
    if (swallowClick) {
      e.stopPropagation()
      e.preventDefault()
      swallowClick = false
    }
  },
  true,
)
document.addEventListener('dblclick', (e) => {
  const zone = e.target.closest('[data-drag]')
  if (!zone || e.target.closest('button, input, textarea, .tab')) return
  const w = WM.wins.get(e.target.closest('.win').dataset.app)
  if (w) WM.toggleMax(w)
})
addEventListener('resize', () => WM.fit())

/* ---------------------------------------------------------------- Moldura das janelas */

function ctrls(w) {
  return `<div class="win-ctrls">
    <button class="icon-btn" data-act="min" title="Minimizar" aria-label="Minimizar">${icon('minus')}</button>
    <button class="icon-btn" data-act="max" title="${w.max ? 'Restaurar' : 'Maximizar'}" aria-label="${w.max ? 'Restaurar' : 'Maximizar'}">${icon(w.max ? 'minimize-2' : 'maximize-2', 14)}</button>
    <button class="icon-btn" data-act="close" title="Fechar" aria-label="Fechar">${icon('x')}</button>
  </div>`
}

/** Monta a janela inteira na primeira vez; depois, só a parte pedida (`part`). */
function renderWin(w, part) {
  if (!w) return
  const R = RENDER[w.app]
  if (part === 'ctrls') {
    const c = $('.win-ctrls', w.el)
    if (c) c.outerHTML = ctrls(w)
    return
  }
  if (!w.el.childElementCount) {
    w.el.innerHTML = R.frame(w)
    R.mount?.(w)
  }
  R.update(w, part)
}

const winOf = (app) => WM.wins.get(app)
const refresh = (app, part) => renderWin(winOf(app), part)
function refreshAll() {
  for (const w of WM.wins.values()) renderWin(w)
  renderRail()
  renderPulse()
  if (overlay === 'quick') renderQuick()
  if (overlay === 'launcher') renderLauncherList()
}

function tabsBar(w, tabs, active, { add = true } = {}) {
  const sel = tabs.findIndex((t) => t.id === active)
  w.el.classList.toggle('first-tab', sel === 0)
  return `<div class="tabs" role="tablist">${tabs
    .map(
      (t) => `<div class="tab" role="tab" tabindex="0" aria-selected="${t.id === active}" data-act="tab" data-id="${t.id}">
        ${t.lead}<span class="truncate">${esc(t.title)}</span>
        ${t.closable !== false ? `<span class="x" role="button" title="Fechar aba" aria-label="Fechar aba" data-act="tabclose" data-id="${t.id}">${icon('x', 12)}</span>` : ''}
      </div>`,
    )
    .join('')}</div>${add ? `<button class="icon-btn" data-act="newtab" title="Nova aba" aria-label="Nova aba" style="margin-bottom:.35rem">${icon('plus')}</button>` : ''}`
}

/* ---------------------------------------------------------------- Claude */

function newChat(title = 'Nova conversa', seed = nextId('conversa:'), msgs = []) {
  const chat = { id: nextId('c'), seed, title, msgs, busy: false, els: new Map() }
  S.chats.push(chat)
  return chat
}
const chatNow = () => S.chats.find((c) => c.id === S.chatTab) ?? S.chats[0]
const mainChat = () => S.chats[0]
function push(chat, m) {
  m.id = nextId('m')
  m.v = 0
  chat.msgs.push(m)
  return m
}

function seedChats() {
  const c = newChat('Liberar espaço', CHAT_SEED)
  S.chatTab = c.id
  push(c, { t: 'user', text: 'O disco tá no vermelho. Dá para liberar espaço sem perder nada importante?' })
  push(c, {
    t: 'activity',
    summary: 'Leu 3 pastas · rodou 2 comandos',
    items: [
      { icon: 'square-terminal', text: 'du -sh ~/.cache/* ~/Downloads/*', meta: '1,2 s', mono: true },
      { icon: 'square-terminal', text: 'docker system df', meta: '0,4 s', mono: true },
      { icon: 'folder', text: '~/Downloads', meta: '9 arquivos', mono: true },
    ],
  })
  proposeCleanup(c)
}

function proposeCleanup(c) {
  push(c, { t: 'text', html: `<p>Achei <strong>${bytes(CLEANUP_TOTAL)}</strong> que dá para tirar sem perder nada:</p>` })
  push(c, {
    t: 'list',
    items: CLEANUP.map((x) => ({ icon: x.icon, label: x.label, meta: bytes(x.size) })),
    note: 'Cache e imagens voltam sozinhos quando precisar; os downloads vão para a lixeira.',
  })
  push(c, { t: 'approval', state: 'pending', title: `Liberar ${bytes(CLEANUP_TOTAL)}?`, cmd: CLEANUP.map((x) => x.cmd).join(' && ') })
  S.claude.phase = 'waiting'
}

function msgHtml(m) {
  switch (m.t) {
    case 'user':
      return `<div class="msg-user">${esc(m.text)}</div>`
    case 'text':
      return `<div class="msg-claude">${m.html}</div>`
    case 'activity':
      return `<details class="activity msg-claude"><summary>${icon('chevron-right', 14, 'chev')}${esc(m.summary)}</summary><div class="group">${m.items
        .map((i) => `<div class="row dense">${icon(i.icon, 14, 'muted')}<span class="grow truncate ${i.mono ? 'mono' : ''}">${esc(i.text)}</span><span class="meta">${esc(i.meta)}</span></div>`)
        .join('')}</div></details>`
    case 'list':
      return `<div class="msg-claude"><div class="group">${m.items
        .map((i) => `<div class="row dense">${icon(i.icon, 16, 'muted')}<span class="grow truncate">${esc(i.label)}</span><span class="meta">${esc(i.meta)}</span></div>`)
        .join('')}</div>${m.note ? `<p class="group-note">${esc(m.note)}</p>` : ''}</div>`
    case 'approval':
      if (m.state === 'pending')
        return `<div class="approval" data-approval>
          <div class="head">${icon('triangle-alert')}<span class="grow">${esc(m.title)}</span></div>
          <div class="cmd">${esc(m.cmd)}</div>
          <div class="acts"><button class="btn btn-primary" data-act="allow">Permitir</button><button class="btn btn-ghost" data-act="deny">Negar</button></div>
        </div>`
      return `<div class="decided">${m.state === 'allowed' ? icon('check', 14) : icon('x', 14)}${m.state === 'allowed' ? 'Permitido' : m.state === 'stopped' ? 'Parado no meio' : 'Negado'} · ${esc(m.title.replace('?', '').replace(/^./, (c) => c.toLowerCase()))}</div>`
  }
}

/** O chat vai só acrescentando: mensagem nova entra com a animação, e só a que mudou é trocada. */
function renderMsgs(chat, box) {
  const quiet = box.dataset.chat !== chat.id
  if (quiet) {
    box.innerHTML = ''
    box.dataset.chat = chat.id
    chat.els = new Map()
  }
  const empty = $('.chat-empty', box)
  if (!chat.msgs.length) {
    if (!empty) box.innerHTML = emptyChat(chat)
    return
  }
  empty?.remove()
  let prev = null
  for (const m of chat.msgs) {
    let rec = chat.els.get(m.id)
    if (!rec || rec.v !== m.v) {
      const tpl = document.createElement('template')
      tpl.innerHTML = msgHtml(m).trim()
      const el = tpl.content.firstElementChild
      if (rec) rec.el.replaceWith(el)
      else if (quiet) el.style.animation = 'none'
      rec = { el, v: m.v }
      chat.els.set(m.id, rec)
    }
    if (prev ? prev.nextElementSibling !== rec.el : box.firstElementChild !== rec.el) {
      if (prev) prev.after(rec.el)
      else box.prepend(rec.el)
    }
    prev = rec.el
  }
}

function emptyChat(chat) {
  const tips = ['Liberar espaço no disco', 'Tema escuro', 'Abrir o terminal', 'Lado a lado']
  return `<div class="chat-empty empty" style="padding-top:18%">
    ${claudinho(chat.seed, { size: 56 })}
    <div>O que eu faço pelo sistema?</div>
    <div style="display:flex;flex-wrap:wrap;gap:.375rem;justify-content:center;max-width:24rem">${tips
      .map((t) => `<button class="btn btn-ghost" data-act="suggest" data-text="${esc(t)}">${esc(t)}</button>`)
      .join('')}</div>
  </div>`
}

function chatState(chat) {
  if (chat === mainChat() && S.claude.phase === 'running') return 'running'
  if (chat === mainChat() && S.claude.phase === 'waiting') return 'waiting'
  return chat.busy ? 'running' : 'idle'
}

const RENDER = {}

RENDER.claude = {
  frame: (w) => `
    <div class="win-bar" data-drag><div class="tabs-slot" style="display:contents"></div>${ctrls(w)}</div>
    <div class="pane"><div class="col">
      <div class="scroll" data-chat-scroll><div class="msgs"></div><div class="msgs" style="padding-top:0;padding-bottom:.5rem"><div class="working hidden"></div></div></div>
      <form class="composer" data-composer>
        <textarea rows="1" placeholder="Peça algo ao sistema" aria-label="Mensagem para o Claude"></textarea>
        <div class="bar">
          <button type="button" class="chip" title="Modelo">${claudeMark(12)}Opus 5.5</button>
          <button type="button" class="chip" title="Modo">Pede licença</button>
          <button type="submit" class="send" disabled title="Enviar" aria-label="Enviar">${icon('arrow-up')}</button>
        </div>
      </form>
    </div></div>
    <div class="grip" data-grip></div>`,
  mount(w) {
    const form = $('[data-composer]', w.el)
    const ta = $('textarea', form)
    const btn = $('.send', form)
    const grow = () => {
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, 128)}px`
      btn.disabled = !ta.value.trim()
    }
    ta.addEventListener('input', grow)
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        form.requestSubmit()
      }
    })
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const text = ta.value.trim()
      if (!text) return
      ta.value = ''
      grow()
      ask(chatNow(), text)
    })
  },
  update(w) {
    const chat = chatNow()
    $('.tabs-slot', w.el).innerHTML = tabsBar(
      w,
      S.chats.map((c, i) => ({ id: c.id, title: c.title, closable: i > 0, lead: claudinho(c.seed, { size: 16, state: chatState(c), status: true }) })),
      chat.id,
    )
    const scroll = $('[data-chat-scroll]', w.el)
    const near = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120
    renderMsgs(chat, $('.msgs', w.el))
    renderWorking(w)
    if (near || chat.stick) {
      chat.stick = false
      requestAnimationFrame(() => scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'smooth' }))
    }
  },
}

function renderWorking(w = winOf('claude')) {
  if (!w) return
  const chat = chatNow()
  const el = $('.working', w.el)
  const running = chat === mainChat() && S.claude.phase === 'running'
  if (!running && !chat.busy) {
    el.classList.add('hidden')
    return
  }
  const secs = Math.max(1, Math.round((Date.now() - (running ? S.claude.started : chat.busySince)) / 1000))
  const sig = running ? `${claudinho(chat.seed, { size: 20, state: 'running' })}` : claudinho(chat.seed, { size: 20, state: 'running', pose: 'think' })
  const key = running ? `run:${S.claude.step}` : 'think'
  if (el.dataset.key !== key) {
    el.dataset.key = key
    el.innerHTML = `<span class="${running ? 'hop' : ''}" style="display:flex">${sig}</span><span class="grow truncate">${
      running ? `Rodando Bash · <span class="mono">${esc(S.claude.step)}</span>` : `${nameOf(chat.seed)} está pensando`
    }</span><span class="num t"></span>`
  }
  $('.t', el).textContent = `${secs}s`
  el.classList.remove('hidden')
}

/** O que o Claude do protótipo sabe fazer: trocar o tema, abrir apps, organizar janelas e liberar espaço. */
async function ask(chat, text) {
  if (chat.title === 'Nova conversa') chat.title = text.length > 28 ? `${text.slice(0, 26)}…` : text
  push(chat, { t: 'user', text })
  chat.busy = true
  chat.busySince = Date.now()
  chat.stick = true
  refresh('claude')
  await sleep(800 + Math.random() * 500)
  chat.busy = false
  const q = norm(text)
  let reply = ''
  let then = null
  if (/escuro|dark|noite/.test(q)) {
    reply = 'Pronto, tema escuro.'
    then = () => setTheme('escuro')
  } else if (/claro|light|dia\b/.test(q)) {
    reply = 'Pronto, tema claro.'
    then = () => setTheme('claro')
  } else if (/lado a lado|organiz|janela/.test(q)) {
    reply = 'Coloquei as duas janelas de cima lado a lado.'
    then = () => WM.tile()
  } else if (/terminal|shell|zsh/.test(q)) {
    reply = 'Abri o terminal.'
    then = () => WM.open('term')
  } else if (/arquivo|pasta|download/.test(q)) {
    reply = 'Abri os Downloads.'
    then = () => {
      S.files.view = 'downloads'
      WM.open('files')
      refresh('files')
    }
  } else if (/navegador|internet|site|browser/.test(q)) {
    reply = 'Abri o navegador.'
    then = () => WM.open('web')
  } else if (/ajuste|configura|wi-?fi|som|bateria/.test(q)) {
    reply = 'Abri os Ajustes.'
    then = () => WM.open('settings')
  } else if (/bloque|tranca/.test(q)) {
    reply = 'Bloqueando a tela.'
    then = () => setTimeout(lock, 500)
  } else if (/espaco|disco|limp|liber/.test(q)) {
    if (S.claude.cleaned) reply = `O disco está em ${Math.round(diskPct())}%. Não sobrou nada grande para tirar.`
    else if (S.claude.phase === 'waiting' || S.claude.phase === 'running') reply = 'Já estou nisso, na primeira conversa.'
    else {
      chat === mainChat() ? proposeCleanup(chat) : (reply = 'Isso eu faço na primeira conversa: lá já está tudo levantado.')
      if (chat === mainChat()) {
        renderPulse()
        renderRail()
      }
    }
  } else if (/^(oi|ola|bom dia|boa tarde|boa noite|e ai)/.test(q)) {
    reply = 'Oi! Posso trocar o tema, abrir apps, organizar as janelas ou liberar espaço no disco.'
  } else {
    reply = 'No protótipo eu sei trocar o tema, abrir apps, organizar as janelas, bloquear a tela e liberar espaço. O resto fica para a versão de verdade.'
  }
  if (reply) push(chat, { t: 'text', html: `<p>${esc(reply)}</p>` })
  chat.stick = true
  refresh('claude')
  then?.()
}

async function allow() {
  const c = mainChat()
  const ap = c.msgs.findLast((m) => m.t === 'approval' && m.state === 'pending')
  if (!ap) return
  ap.state = 'allowed'
  ap.v++
  const run = ++S.claude.run
  Object.assign(S.claude, { phase: 'running', started: Date.now(), step: CLEANUP[0].cmd })
  c.stick = true
  refreshAll()
  const alive = () => S.claude.run === run && S.claude.phase === 'running'
  // Um passo por item: o disco desce na hora, e os downloads saem da lista um por um.
  await sleep(1800)
  if (!alive()) return
  S.diskUsed -= CLEANUP[0].size
  S.claude.step = CLEANUP[1].cmd
  refreshAll()
  await sleep(1600)
  if (!alive()) return
  S.diskUsed -= CLEANUP[1].size
  S.claude.step = 'gio trash ~/Downloads/archlinux-…iso …'
  refreshAll()
  for (const f of S.downloads.filter((d) => d.junk)) {
    await sleep(260)
    if (!alive()) return
    await removeDownload(f)
  }
  await sleep(400)
  if (!alive()) return
  S.claude.cleaned = true
  S.claude.phase = 'done'
  push(c, {
    t: 'text',
    html: `<p>Pronto: <strong>${bytes(CLEANUP_TOTAL)}</strong> livres, e o disco está em ${Math.round(diskPct())}%.</p><p>Os downloads ficam na lixeira por 30 dias, caso precise de algum.</p>`,
  })
  c.stick = true
  refreshAll()
  toast({
    lead: claudinho(c.seed, { size: 28, pose: 'done' }),
    title: `${nameOf(c.seed)} terminou`,
    desc: `${bytes(CLEANUP_TOTAL)} livres`,
    action: { label: 'Ver lixeira', fn: () => openFiles('lixeira') },
  })
  await sleep(2600)
  if (S.claude.phase === 'done') {
    S.claude.phase = 'idle'
    renderPulse()
    refresh('claude')
  }
}

async function removeDownload(f) {
  const row = $(`.files-list [data-file="${CSS.escape(f.name)}"]`)
  if (row && S.files.view === 'downloads') {
    row.classList.add('leaving')
    await sleep(320)
  }
  S.downloads = S.downloads.filter((d) => d !== f)
  S.trash.push({ ...f, from: 'Downloads' })
  S.diskUsed -= f.size
  refresh('files')
  renderRail()
}

function deny() {
  const c = mainChat()
  const ap = c.msgs.findLast((m) => m.t === 'approval' && m.state === 'pending')
  if (!ap) return
  ap.state = 'denied'
  ap.v++
  S.claude.phase = 'idle'
  push(c, { t: 'text', html: '<p>Tudo bem, não mexi em nada. Quando quiser, é só pedir de novo.</p>' })
  c.stick = true
  refreshAll()
}

function stopClaude() {
  if (S.claude.phase !== 'running') return
  const c = mainChat()
  const ap = c.msgs.findLast((m) => m.t === 'approval')
  if (ap) {
    ap.state = 'stopped'
    ap.v++
  }
  S.claude.phase = 'idle'
  push(c, { t: 'text', html: '<p>Parei. O que já saiu volta sozinho quando precisar, e os downloads estão na lixeira.</p>' })
  c.stick = true
  refreshAll()
}

/* A ilha do alto: o Claude em segundo plano, esperando você ou acabando de terminar. */
function renderPulse() {
  const el = $('#pulse')
  const { phase } = S.claude
  const c = mainChat()
  if (S.locked || !c || phase === 'idle') {
    el.classList.add('gone')
    return
  }
  const key = phase
  if (el.dataset.key !== key) {
    el.dataset.key = key
    const state = phase === 'done' ? undefined : phase
    const what = phase === 'waiting' ? 'Esperando você' : phase === 'running' ? 'Liberando espaço' : 'Pronto'
    const meta = phase === 'waiting' ? `Liberar ${bytes(CLEANUP_TOTAL)}` : phase === 'running' ? '' : `${bytes(CLEANUP_TOTAL)} livres`
    el.innerHTML = `<span class="pill-claudinho">${claudinho(c.seed, { size: 24, state, status: true, pose: phase === 'done' ? 'done' : undefined })}</span>
      <span class="what" data-s="${phase}">${what}</span><span class="meta">${meta}</span>
      ${phase === 'running' ? `<button class="icon-btn" data-act="stop" title="Parar" aria-label="Parar">${icon('square', 12)}</button>` : '<span class="pill-pad"></span>'}`
    el.title = phase === 'waiting' ? 'Abrir a conversa' : ''
  }
  if (phase === 'running') $('.meta', el).textContent = `${Math.max(1, Math.round((Date.now() - S.claude.started) / 1000))}s`
  el.classList.toggle('near', WM.focused?.app === 'claude')
  el.classList.remove('gone')
}

/* ---------------------------------------------------------------- Arquivos */

const FILE_VIEWS = {
  inicio: { label: 'Início', icon: 'house', path: '~' },
  projetos: { label: 'Projetos', icon: 'folder-git-2', path: '~/Projects' },
  downloads: { label: 'Downloads', icon: 'download', path: '~/Downloads' },
  imagens: { label: 'Imagens', icon: 'image', path: '~/Imagens' },
  lixeira: { label: 'Lixeira', icon: 'trash', path: 'Lixeira' },
}

function openFiles(view) {
  S.files.view = view
  S.files.sel = null
  WM.open('files')
  refresh('files')
}

function diskBlock() {
  const p = diskPct()
  return `<div data-level="${severity(p)}"><div class="top"><span class="muted">Disco</span><span class="lv-text num">${Math.round(p)}%</span></div><span class="track"><span style="width:${p}%"></span></span><div class="muted" style="font-size:11px;margin-top:.375rem">${bytes(DISK_TOTAL - S.diskUsed)} livres</div></div>`
}

RENDER.files = {
  frame: (w) => `
    <nav class="side" data-drag aria-label="Lugares"><div class="side-title">${icon('folder')}Arquivos</div><div class="nav"></div><div class="side-foot"></div></nav>
    <div class="pane"><div class="col">
      <header class="win-head" data-drag><div class="grow"><h2></h2><p class="mono"></p></div><div class="head-acts" style="display:flex;gap:.125rem;align-items:center"></div>${ctrls(w)}</header>
      <div class="scroll"><div class="content files-list"></div></div>
    </div></div>
    <div class="grip" data-grip></div>`,
  update(w) {
    const v = S.files.view
    const nav = (id) => {
      const it = FILE_VIEWS[id]
      const count = id === 'lixeira' ? S.trash.length : id === 'downloads' ? S.downloads.length : 0
      return `<button class="nav-item" data-act="fview" data-id="${id}" ${v === id ? 'aria-current="page"' : ''}>${icon(it.icon)}<span class="truncate">${it.label}</span>${count ? `<span class="count">${count}</span>` : ''}</button>`
    }
    $('.nav', w.el).innerHTML = `<div class="nav-group">${['inicio', 'projetos', 'downloads', 'imagens'].map(nav).join('')}</div><div class="nav-group">${nav('lixeira')}</div>`
    $('.side-foot', w.el).innerHTML = diskBlock()
    const it = FILE_VIEWS[v]
    $('h2', w.el).textContent = it.label
    const list = filesOf(v)
    $('.win-head p', w.el).textContent = `${it.path} · ${list.length} ${list.length === 1 ? 'item' : 'itens'}`
    $('.head-acts', w.el).innerHTML =
      (v === 'lixeira' && S.trash.length ? `<button class="btn btn-ghost" data-act="empty-trash" style="height:1.75rem;font-size:12px">Esvaziar</button>` : '') +
      `<button class="icon-btn" data-act="fsearch" title="Buscar" aria-label="Buscar">${icon('search')}</button>`
    const q = norm(S.files.q)
    const shown = q ? list.filter((f) => norm(f.name).includes(q)) : list
    const search = S.files.search
      ? `<div class="section"><input class="fsearch" placeholder="Buscar em ${esc(it.label)}" value="${esc(S.files.q)}" style="width:100%;border:0;border-radius:.75rem;background:color-mix(in oklab,var(--foreground) 5%,transparent);padding:.5rem .75rem;outline:none" /></div>`
      : ''
    let body = ''
    if (v === 'imagens') body = imagesGrid()
    else if (!shown.length) body = emptyFiles(v, q)
    else body = `<div class="section"><div class="group">${shown.map((f) => fileRow(f, v)).join('')}</div>${v === 'lixeira' ? '<p class="group-note">Some sozinho depois de 30 dias.</p>' : ''}</div>`
    const box = $('.files-list', w.el)
    const focusSearch = document.activeElement?.classList.contains('fsearch')
    box.innerHTML = search + body
    if (S.files.search) {
      const inp = $('.fsearch', box)
      inp.oninput = () => {
        S.files.q = inp.value
        refresh('files')
      }
      if (focusSearch || S.files.justOpened) {
        inp.focus()
        inp.setSelectionRange(inp.value.length, inp.value.length)
        S.files.justOpened = false
      }
    }
  },
}

function filesOf(v) {
  if (v === 'projetos') return S.projects
  if (v === 'downloads') return S.downloads
  if (v === 'lixeira') return S.trash
  if (v === 'imagens') return IMAGES
  return [
    { name: 'notas-reuniao.md', icon: 'file-code', when: 'hoje', size: 4e3 },
    { name: 'cald', project: true, branch: 'main', add: 12, del: 3, when: 'agora' },
    { name: 'contrato-prestacao.pdf', icon: 'file-text', when: 'ontem', size: 240e3 },
    { name: 'ondas.png', icon: 'image', when: '5 dias', size: 3.1e6 },
  ]
}

function fileRow(f, v) {
  const isProject = v === 'projetos' || f.project
  const lead = isProject ? pmark(f.name) : icon(f.icon, 16)
  const extra = isProject
    ? `<span class="branch">${icon('git-branch', 11)}${esc(f.branch)}</span>${f.add || f.del ? `<span class="branch">${f.add ? `<span class="diff-add">+${f.add}</span>` : ''}${f.del ? `<span class="diff-del">−${f.del}</span>` : ''}</span>` : ''}`
    : ''
  const meta = v === 'lixeira' ? `<button class="btn btn-ghost on-hover" data-act="restore" data-file="${esc(f.name)}" style="height:1.625rem;font-size:12px">${icon('undo-2', 13)}Restaurar</button><span class="meta">${bytes(f.size)}</span>` : `<span class="meta">${f.size ? bytes(f.size) : esc(f.when)}</span>`
  return `<div class="row dense hoverable file-row" tabindex="0" data-file="${esc(f.name)}" data-act="fsel" ${isProject ? 'data-project="1"' : ''} aria-selected="${S.files.sel === f.name}" title="${isProject ? 'Dois cliques abrem no terminal' : ''}">${lead}<span class="grow truncate">${esc(f.name)}</span>${extra}${meta}</div>`
}

function emptyFiles(v, q) {
  if (q) return `<div class="empty">${icon('search', 40)}<div>Nada com “${esc(S.files.q)}”</div></div>`
  if (v === 'lixeira') return `<div class="empty">${icon('trash', 40)}<div>Lixeira vazia</div></div>`
  return `<div class="empty">${icon('folder', 40)}<div>Pasta vazia</div></div>`
}

const IMAGES = [
  { name: 'ondas.png', art: '.:-~=+*#*+=~-:.  .:-~=+*#\n  .:-~=+*#*+=~-:.  .:-~=\n.:-~=+*#*+=~-:.  .:-~=+*#\n    .:-~=+*#*+=~-:.  .:-~\n.:-~=+*#*+=~-:.  .:-~=+*#' },
  { name: 'tela-cald.png', art: '┌──┬──────────────────┐\n│▪▪│ ▔▔▔▔▔▔           │\n│▪▪│ ▔▔▔▔▔▔▔▔▔▔       │\n│▪▪│           ▔▔▔▔▔▔ │\n│  │ ▔▔▔▔▔▔▔▔         │\n└──┴──────────────────┘' },
  { name: 'claudinhos.png', art: '  ▄▄▄    ▄▄▄    ▄▄▄\n █ █ █  █ █ █  █ █ █\n █▄▄▄█  █▄▄▄█  █▄▄▄█\n\n  ▄▄▄    ▄▄▄    ▄▄▄\n █ █ █  █ █ █  █ █ █' },
  { name: 'diagrama.png', art: '   ┌───┐\n   │ ◇ │──┐\n   └───┘  │\n     │  ┌─┴─┐\n     └──│ ○ │\n        └───┘' },
]
function imagesGrid() {
  return `<div class="section thumbs">${IMAGES.map((i) => `<div class="thumb"><pre>${esc(i.art)}</pre><span class="truncate">${esc(i.name)}</span></div>`).join('')}</div>`
}

function restore(name) {
  const f = S.trash.find((t) => t.name === name)
  if (!f) return
  S.trash = S.trash.filter((t) => t !== f)
  const { from, ...file } = f
  S.downloads.push(file)
  S.downloads.sort((a, b) => b.size - a.size)
  S.diskUsed += f.size
  refreshAll()
  toast({ lead: icon('undo-2', 18, 'muted'), title: 'Restaurado', desc: `${f.name} voltou para ${from}` })
}

/* ---------------------------------------------------------------- Terminal */

const TERM_HEAD = (cwd, branch) => `<span class="mono">${esc(cwd)}</span>${branch ? `<span class="branch">${icon('git-branch', 11)}${esc(branch)}</span>` : ''}`

/**
 * A marca do cald em pixels grandes, como a arte do neofetch: o desenho de verdade lido numa grade
 * pequena, em retângulos (como caractere de bloco, a fonte deixava fresta entre as colunas).
 */
function fetchArt(cols = 17, rows = 20) {
  const c = document.createElement('canvas')
  c.width = cols
  c.height = rows
  const g = c.getContext('2d')
  g.scale(cols / 30, rows / 30)
  g.translate(-1, -1.5)
  g.fill(new Path2D(CALD_PATH), 'evenodd')
  const d = g.getImageData(0, 0, cols, rows).data
  let rects = ''
  for (let y = 0; y < rows; y++) {
    let start = -1
    for (let x = 0; x <= cols; x++) {
      const on = x < cols && d[(y * cols + x) * 4 + 3] > 120
      if (on && start < 0) start = x
      if (!on && start >= 0) {
        rects += `<rect x="${start}" y="${y}" width="${x - start}" height="1"/>`
        start = -1
      }
    }
  }
  return `<svg class="art" viewBox="0 0 ${cols} ${rows}" width="${cols * 9}" height="${rows * 7.75}" preserveAspectRatio="none" shape-rendering="crispEdges" fill="currentColor" aria-hidden="true">${rects}</svg>`
}
function neofetch() {
  const p = Math.round(diskPct())
  const rows = [
    ['SO', 'cald os 1.0 (base Arch)'],
    ['Kernel', '7.2.9-arch1-1'],
    ['Uptime', '2 h 14 min'],
    ['Shell', 'zsh 5.9'],
    ['Janelas', 'ilhas'],
    ['Tema', `Ondas · ${isDark() ? 'escuro' : 'claro'}`],
    ['Fontes', 'Geist, Cascadia Code'],
    ['CPU', 'Ryzen 7 7840U (16)'],
    ['Memória', '9,5 GiB / 15,6 GiB'],
    ['Disco', `${bytes(S.diskUsed)} / ${bytes(DISK_TOTAL)} (${p}%)`],
  ]
  return `<div class="fetch">${fetchArt()}<div><b>${ME}</b><span class="muted">@</span><b>cald</b>\n<span class="muted">──────────</span>\n${rows
    .map(([k, v]) => `<span class="k">${k}</span>${esc(v)}`)
    .join('\n')}\n\n${CLAUDINHO_COLORS.map((c) => `<span class="swatch" style="background:${c}"></span>`).join('')}</div></div>`
}

function seedTerm() {
  S.term.tabs = [
    {
      id: 't1',
      title: 'cald',
      cwd: '~/Projects/cald',
      branch: 'main',
      running: true,
      blocks: [
        { cwd: '~/Projects/cald', branch: 'main', cmd: 'git pull', state: 'ok', st: 'ok · 0,9s', out: esc('Já está atualizado.') },
        {
          cwd: '~/Projects/cald',
          branch: 'main',
          cmd: 'pnpm dev',
          state: 'running',
          st: 'rodando · 2 h 14 min',
          out: esc('> cald@1.0.0 dev\n> pnpm -r --parallel dev\n\nweb    │ VITE v7.2  pronto em 412 ms\nweb    │ ➜  Local: http://localhost:5173/\nserver │ ouvindo em :7878 · 2 máquinas'),
        },
      ],
    },
    { id: 't2', title: '~', cwd: '~', blocks: [{ cwd: '~', branch: undefined, cmd: 'neofetch', state: 'ok', st: 'ok · 0,1s', html: true, out: neofetch() }] },
  ]
  S.term.tab = 't2'
}
const termNow = () => S.term.tabs.find((t) => t.id === S.term.tab) ?? S.term.tabs[0]

RENDER.term = {
  frame: (w) => `
    <div class="win-bar" data-drag><div class="tabs-slot" style="display:contents"></div>${ctrls(w)}</div>
    <div class="pane"><div class="term">
      <div class="scroll" data-term-scroll><div class="blocks"></div></div>
      <label class="prompt"><span class="muted cwd"></span><span class="p">❯</span><input spellcheck="false" autocomplete="off" aria-label="Comando" placeholder="" /></label>
    </div></div>
    <div class="grip" data-grip></div>`,
  mount(w) {
    const inp = $('.prompt input', w.el)
    $('.term', w.el).addEventListener('click', (e) => {
      if (!getSelection().toString() && !e.target.closest('summary')) inp.focus()
    })
    inp.addEventListener('keydown', (e) => {
      const h = S.term.history
      if (e.key === 'Enter') {
        const cmd = inp.value
        inp.value = ''
        if (cmd.trim()) {
          h.push(cmd)
          S.term.hi = h.length
        }
        runCmd(cmd)
      } else if (e.key === 'ArrowUp' && h.length) {
        S.term.hi = Math.max(0, S.term.hi - 1)
        inp.value = h[S.term.hi] ?? ''
        e.preventDefault()
      } else if (e.key === 'ArrowDown' && h.length) {
        S.term.hi = Math.min(h.length, S.term.hi + 1)
        inp.value = h[S.term.hi] ?? ''
        e.preventDefault()
      } else if (e.key === 'l' && e.ctrlKey) {
        termNow().blocks = []
        refresh('term')
        e.preventDefault()
      }
    })
    if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => WM.focused === w && inp.focus({ preventScroll: true }), 50)
  },
  update(w) {
    const t = termNow()
    $('.tabs-slot', w.el).innerHTML = tabsBar(
      w,
      S.term.tabs.map((x) => ({ id: x.id, title: x.title, lead: x.running ? '<span class="dot" title="Rodando"></span>' : icon('square-terminal', 14, 'muted') })),
      t.id,
    )
    $('.blocks', w.el).innerHTML = t.blocks
      .map(
        (b) => `<div class="blk"><div class="blk-head" data-state="${b.state}">${TERM_HEAD(b.cwd ?? t.cwd, 'cwd' in b ? b.branch : t.branch)}<span class="st">${esc(b.st)}</span></div><div class="blk-cmd">${esc(b.cmd)}</div>${b.out ? `<pre>${b.out}</pre>` : ''}</div>`,
      )
      .join('')
    $('.cwd', w.el).textContent = t.cwd
    const sc = $('[data-term-scroll]', w.el)
    sc.scrollTop = sc.scrollHeight
  },
}

function runCmd(raw) {
  const t = termNow()
  const cmd = raw.trim()
  if (!cmd) return
  const [name, ...args] = cmd.split(/\s+/)
  const rest = cmd.slice(name.length).trim()
  const at = { cwd: t.cwd, branch: t.branch }
  const ok = (out, html = false) => t.blocks.push({ ...at, cmd, state: 'ok', st: `ok · 0,${1 + Math.floor(Math.random() * 4)}s`, out: html ? out : esc(out) })
  const fail = (out, code = 1) => t.blocks.push({ ...at, cmd, state: 'fail', st: `erro ${code}`, out: esc(out) })
  switch (name) {
    case 'clear':
      t.blocks = []
      break
    case 'help':
    case 'ajuda':
      ok(
        [
          'neofetch        o sistema, em resumo',
          'ls [pasta]      o que tem na pasta (~, Downloads, Projects)',
          'df -h           o disco',
          'claude <texto>  pede algo ao Claude',
          'tema claro|escuro',
          'date · whoami · uname -a · echo · clear · exit',
        ].join('\n'),
      )
      break
    case 'neofetch':
    case 'fastfetch':
      ok(neofetch(), true)
      break
    case 'ls': {
      const dir = norm(args[0] ?? '~').replace(/^~\/?/, '').replace(/\/$/, '')
      if (!dir) ok('Documentos/  Downloads/  Imagens/  Projects/  notas.md')
      else if (dir === 'downloads') ok(S.downloads.map((d) => d.name).join('\n') || '')
      else if (dir === 'projects') ok(S.projects.map((p) => `${p.name}/`).join('  '))
      else fail(`ls: não foi possível acessar '${args[0]}': Arquivo ou diretório inexistente`, 2)
      break
    }
    case 'df':
      ok(`Sist. Arq.      Tam.  Usado  Disp.  Uso%  Montado em\n/dev/nvme0n1p2  ${Math.round(DISK_TOTAL / 1e9)}G   ${Math.round(S.diskUsed / 1e9)}G   ${Math.round((DISK_TOTAL - S.diskUsed) / 1e9)}G    ${Math.round(diskPct())}%   /`)
      break
    case 'date':
      ok(new Date().toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'medium' }))
      break
    case 'whoami':
      ok(ME)
      break
    case 'uname':
      ok(args.includes('-a') ? 'Linux cald 7.2.9-arch1-1 #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux' : 'Linux')
      break
    case 'echo':
      ok(rest.replace(/^["']|["']$/g, ''))
      break
    case 'tema':
      if (/escuro|claro|sistema/.test(rest)) {
        ok(`tema ${rest}`)
        setTheme(rest.includes('escuro') ? 'escuro' : rest.includes('claro') ? 'claro' : 'sistema')
      } else fail('uso: tema claro|escuro|sistema', 2)
      break
    case 'claude': {
      const text = rest.replace(/^["']|["']$/g, '')
      if (!text) {
        WM.open('claude')
        ok('')
        break
      }
      ok(`→ enviado ao Claude`)
      WM.open('claude', { background: true })
      ask(chatNow(), text)
      break
    }
    case 'exit':
      if (S.term.tabs.length > 1) closeTermTab(t.id)
      else WM.close(winOf('term'))
      return
    case 'sudo':
      fail(`${ME} não está no arquivo sudoers. Peça ao Claude: ele pede licença antes.`)
      break
    case 'cd':
      if (!args[0] || args[0] === '~') {
        t.cwd = '~'
        t.branch = undefined
        t.title = '~'
        ok('')
      } else {
        const p = S.projects.find((x) => args[0].replace(/\/$/, '').endsWith(x.name))
        if (p) {
          ok('')
          t.cwd = `~/Projects/${p.name}`
          t.branch = p.branch
          t.title = p.name
        } else {
          fail(`cd: arquivo ou diretório inexistente: ${args[0]}`)
          break
        }
      }
      break
    default:
      fail(`zsh: comando não encontrado: ${name}`, 127)
  }
  refresh('term')
}

function newTermTab(cwd = '~', branch, title = '~') {
  const id = nextId('t')
  S.term.tabs.push({ id, title, cwd, branch, blocks: [] })
  S.term.tab = id
}
function closeTermTab(id) {
  S.term.tabs = S.term.tabs.filter((t) => t.id !== id)
  if (!S.term.tabs.length) return WM.close(winOf('term'))
  if (S.term.tab === id) S.term.tab = S.term.tabs.at(-1).id
  refresh('term')
}

/* ---------------------------------------------------------------- Navegador */

const SHORTCUTS = [
  { title: 'claude.ai', face: () => claudeMark(20), url: 'claude.ai' },
  { title: 'cald', face: () => caldMark(20), url: 'cald.local' },
  { title: 'GitHub', face: () => pmark('GitHub'), url: 'github.com/valb-mig' },
  { title: 'Tailnet', face: () => pmark('tailnet'), url: 'login.tailscale.com' },
]
const webNow = () => S.web.tabs.find((t) => t.id === S.web.tab) ?? S.web.tabs[0]

RENDER.web = {
  frame: (w) => `
    <div class="win-bar" data-drag><div class="tabs-slot" style="display:contents"></div>${ctrls(w)}</div>
    <div class="pane"><div class="col">
      <form class="addr" data-addr>${icon('globe', 14)}<input placeholder="Pesquisar ou digitar endereço" aria-label="Endereço" /></form>
      <div class="web-body col"></div>
    </div></div>
    <div class="grip" data-grip></div>`,
  mount(w) {
    $('[data-addr]', w.el).addEventListener('submit', (e) => {
      e.preventDefault()
      go($('input', e.target).value)
    })
  },
  update(w) {
    const t = webNow()
    $('.tabs-slot', w.el).innerHTML = tabsBar(
      w,
      S.web.tabs.map((x) => ({ id: x.id, title: x.title, lead: x.url ? pmark(x.title) : icon('globe', 14, 'muted') })),
      t.id,
    )
    const addr = $('[data-addr] input', w.el)
    if (document.activeElement !== addr) addr.value = t.url
    $('.web-body', w.el).innerHTML = t.url
      ? `<div class="empty" style="flex:1">${bigMark(t.title)}<div style="color:var(--foreground);font-size:15px">${esc(t.title)}</div><div>O protótipo não navega de verdade</div><button class="btn btn-ghost" data-act="web-home">${icon('arrow-left', 14)}Voltar</button></div>`
      : `<div class="newtab"><span class="mark">${caldMark(44)}</span>
          <form class="search" data-search>${icon('search')}<input placeholder="Pesquisar ou digitar endereço" aria-label="Pesquisar" /></form>
          <div class="shortcuts">${SHORTCUTS.map((s, i) => `<button class="shortcut" data-act="shortcut" data-i="${i}"><span class="face">${s.face()}</span>${esc(s.title)}</button>`).join('')}</div>
        </div>`
    const search = $('[data-search]', w.el)
    search?.addEventListener('submit', (e) => {
      e.preventDefault()
      go($('input', search).value)
    })
  },
}
function go(raw) {
  const v = raw.trim()
  if (!v) return
  const t = webNow()
  t.url = v.includes('.') && !v.includes(' ') ? v.replace(/^https?:\/\//, '') : `busca?q=${v}`
  t.title = v.includes('.') && !v.includes(' ') ? t.url.split('/')[0] : v
  refresh('web')
}

/* ---------------------------------------------------------------- Ajustes */

const SETTINGS_VIEWS = {
  aparencia: { label: 'Aparência', icon: 'palette' },
  rede: { label: 'Rede', icon: 'wifi' },
  som: { label: 'Som', icon: 'volume-2' },
  energia: { label: 'Energia', icon: 'battery-medium' },
  sobre: { label: 'Sobre', icon: 'info' },
}
const seg = (key, value, opts) =>
  `<div class="segmented" role="group">${opts
    .map(([v, label, ic]) => `<button type="button" data-act="seg" data-key="${key}" data-val="${v}" aria-pressed="${value === v}">${ic ? icon(ic) : ''}${label}</button>`)
    .join('')}</div>`
const sw = (key, label) => `<button type="button" class="switch" role="switch" aria-checked="${!!S[key]}" aria-label="${esc(label)}" data-act="toggle" data-key="${key}"></button>`
const row = (label, hint, control = '') =>
  `<div class="row"><div class="grow"><div class="label">${label}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>${control ? `<div style="display:flex;align-items:center;gap:.375rem;flex-shrink:0">${control}</div>` : ''}</div>`
const section = (title, inner, note) => `<section class="section">${title ? `<h3 class="group-title">${title}</h3>` : ''}${inner}${note ? `<p class="group-note">${note}</p>` : ''}</section>`
const slider = (key, label) => `<input type="range" class="slider" min="0" max="100" value="${S[key]}" style="--v:${S[key]}%" data-key="${key}" aria-label="${label}" />`
const wifiBars = (n) => `<span class="bars" aria-hidden="true">${[5, 8, 11, 14].map((h, i) => `<i class="${i < n ? '' : 'off'}" style="height:${h}px"></i>`).join('')}</span>`

const SETTINGS_BODY = {
  aparencia: () =>
    section('Tema', seg('theme', S.theme, [['claro', 'Claro', 'sun'], ['escuro', 'Escuro', 'moon'], ['sistema', 'Sistema', 'monitor']])) +
    section(
      'Cena',
      seg('scene', S.scene ? 'ondas' : 'nenhuma', [['ondas', 'Ondas'], ['nenhuma', 'Nenhuma']]) +
        `<div class="group" style="margin-top:.5rem">${row('Outras linhas', 'A cena nasce de novo, com outras ondas', `<button class="btn btn-ghost" data-act="reroll" ${S.scene ? '' : 'disabled style="opacity:.4"'}>${icon('rotate-cw', 14)}Sortear</button>`)}</div>`,
    ) +
    section('', `<div class="group">${row('Reduzir movimento', 'Para a cena e as animações', sw('calm', 'Reduzir movimento'))}</div>`),
  rede: () =>
    section('', `<div class="group">${row('Wi-Fi', S.wifi ? `Conectado a ${S.net}` : 'Desligado', sw('wifi', 'Wi-Fi'))}</div>`) +
    (S.wifi
      ? section(
          'Redes',
          `<div class="group">${[
            ['casa-5g', 4],
            ['abraz-escritorio', 3, true],
            [`iPhone de ${ME}`, 2, true],
          ]
            .map(
              ([n, b, locked]) =>
                `<button class="row" data-act="net" data-id="${esc(n)}">${wifiBars(b)}<span class="grow truncate">${esc(n)}</span>${S.net === n ? `<span class="meta" style="color:var(--emerald-text);display:flex;align-items:center;gap:.25rem">${icon('check', 14)}Conectada</span>` : locked ? icon('lock', 14, 'muted') : ''}</button>`,
            )
            .join('')}</div>`,
        )
      : '') +
    section(
      'Tailnet',
      `<div class="group"><div class="row">${caldMark(16)}<div class="grow"><div class="label">cald</div><div class="hint">4 aparelhos · este PC e o celular</div></div><span class="meta" style="color:var(--emerald-text)">Conectado</span></div></div>`,
    ),
  som: () =>
    section('', `<div class="group"><div class="row">${icon('volume-2', 16, 'muted')}${slider('volume', 'Volume')}<span class="meta num" style="width:2rem;text-align:right" data-val="volume">${S.volume}%</span></div></div>`) +
    section('Saída', seg('output', S.output, [['alto-falantes', 'Alto-falantes'], ['fone', 'Fone']])) +
    section('', `<div class="group">${row('Sons do cald', 'Um toque quando o Claude termina', sw('sounds', 'Sons do cald'))}</div>`),
  energia: () =>
    section(
      '',
      `<div class="group"><div class="row">${icon('battery-medium', 18, 'muted')}<div class="grow"><div class="label num">${S.battery}%</div><div class="hint">3 h 40 min restantes</div></div></div><div style="padding:0 .75rem .75rem"><span class="track"><span style="width:${S.battery}%"></span></span></div></div>`,
    ) +
    section('Modo', seg('power', S.power, [['economia', 'Economia'], ['equilibrado', 'Equilibrado'], ['desempenho', 'Desempenho']])) +
    section('Suspender após', seg('sleep', S.sleep, [['5', '5 min'], ['15', '15 min'], ['nunca', 'Nunca']])),
  sobre: () =>
    `<div class="about">${caldMark(48)}<b>cald os</b><span class="muted" style="font-size:13px">1.0 · base Arch</span></div>` +
    section(
      '',
      `<div class="group">${[
        ['Máquina', `${ME}-laptop`],
        ['Kernel', '7.2.9-arch1-1'],
        ['Processador', 'Ryzen 7 7840U'],
        ['Memória', '16 GB'],
        ['Disco', `${bytes(DISK_TOTAL)} · ${Math.round(diskPct())}% usado`],
      ]
        .map(([k, v]) => row(k, '', `<span class="meta mono" style="font-size:12px">${esc(v)}</span>`))
        .join('')}</div>`,
    ),
}

RENDER.settings = {
  frame: (w) => `
    <nav class="side" data-drag aria-label="Ajustes"><div class="side-title">${icon('settings-2')}Ajustes</div><div class="nav"></div></nav>
    <div class="pane"><div class="col">
      <header class="win-head" data-drag><div class="grow"><h2></h2></div>${ctrls(w)}</header>
      <div class="scroll"><div class="content settings-body"></div></div>
    </div></div>
    <div class="grip" data-grip></div>`,
  update(w) {
    const v = S.settings.view
    const nav = (id) =>
      `<button class="nav-item" data-act="sview" data-id="${id}" ${v === id ? 'aria-current="page"' : ''}>${icon(SETTINGS_VIEWS[id].icon)}<span class="truncate">${SETTINGS_VIEWS[id].label}</span></button>`
    $('.nav', w.el).innerHTML = `<div class="nav-group"><h3>Sistema</h3>${['aparencia', 'rede', 'som', 'energia'].map(nav).join('')}</div><div class="nav-group">${nav('sobre')}</div>`
    $('h2', w.el).textContent = SETTINGS_VIEWS[v].label
    $('.settings-body', w.el).innerHTML = SETTINGS_BODY[v]()
  },
}

/* ---------------------------------------------------------------- Alça */

function meter(label, pct, tip, onClick = 'quick') {
  const lv = severity(pct)
  const alert = lv === 'critical' ? icon('triangle-alert', 10, 'meter-alert') : lv === 'warning' ? icon('triangle-alert', 10, 'meter-alert') : ''
  return `<button class="meter" data-level="${lv}" data-act="${onClick}" title="${esc(tip)}" aria-label="${esc(tip)}"><span class="v lv-text">${Math.round(pct)}%</span><span class="track"><span style="width:${pct}%"></span></span><span class="l">${alert}${label}</span></button>`
}

function renderRail() {
  const rail = $('#rail')
  if (!rail.childElementCount) {
    rail.innerHTML = `
      <button class="rail-btn" data-act="launcher" data-tip="Início · Ctrl K" aria-label="Início">${caldMark(22)}</button>
      <div class="rail-sep"></div>
      <div class="rail-apps"></div>
      <div class="rail-spacer"></div>
      <div class="rail-meters" style="display:contents"></div>
      <button class="rail-status" data-act="quick" aria-label="Painel rápido" aria-expanded="false"></button>`
  }
  $('.rail-apps', rail).innerHTML = RAIL_APPS.map((a) => {
    const w = WM.wins.get(a)
    const cur = WM.focused?.app === a && !w?.min
    const sig = a === 'claude' && (S.claude.phase === 'running' || S.claude.phase === 'waiting') ? `<span class="sig" data-s="${S.claude.phase}"></span>` : ''
    return `<button class="rail-btn" data-act="rail" data-app="${a}" data-tip="${APPS[a].title}" aria-label="${APPS[a].title}" aria-current="${cur}" data-open="${!!w}"><span class="run"></span>${APPS[a].glyph()}${sig}</button>`
  }).join('')
  const p = diskPct()
  $('.rail-meters', rail).innerHTML =
    meter('CPU', S.cpu, `Processador: ${Math.round(S.cpu)}%`) +
    meter('RAM', S.ram, `Memória: ${Math.round(S.ram)}% de 16 GB`) +
    meter('Disco', p, `Disco: ${bytes(DISK_TOTAL - S.diskUsed)} livres`, 'disk')
  const now = new Date()
  $('.rail-status', rail).innerHTML = `<span class="icons">${S.wifi ? icon('wifi', 14) : icon('wifi', 14, 'muted') }${icon('battery-medium', 14)}</span>
    <span class="rail-clock"><b>${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</b><span>${now.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric' }).replace('.', '').replace(',', '')}</span></span>`
  $('.rail-status', rail).setAttribute('aria-expanded', overlay === 'quick')
}

/* ---------------------------------------------------------------- Sobreposições */

let overlay = null
function closeOverlay() {
  overlay = null
  $('#overlay').innerHTML = ''
  renderRail()
}

function renderQuick() {
  const tile = (key, ic, t, s) => `<button class="tile" data-act="toggle" data-key="${key}" aria-pressed="${!!S[key]}">${icon(ic, 18)}<span class="grow"><div class="t">${t}</div><div class="s truncate">${s}</div></span></button>`
  $('#overlay').innerHTML = `<div class="veil" data-act="close-overlay" style="background:transparent"></div>
    <div class="quick" role="dialog" aria-label="Painel rápido"><div class="pane">
      <div class="who">${claudinho(ME, { size: 32 })}<div class="grow"><div style="font-weight:500">${ME}</div><div class="muted" style="font-size:12px">cald os 1.0</div></div>
        <button class="icon-btn" data-act="open-settings" title="Ajustes" aria-label="Ajustes">${icon('settings-2')}</button>
        <button class="icon-btn" data-act="lock" title="Bloquear" aria-label="Bloquear">${icon('lock')}</button>
        <button class="icon-btn" data-act="power" title="Desligar" aria-label="Desligar">${icon('power')}</button>
      </div>
      <div class="tiles">
        ${tile('wifi', 'wifi', 'Wi-Fi', S.wifi ? S.net : 'Desligado')}
        ${tile('bt', 'bluetooth', 'Bluetooth', S.bt ? 'Fone · 70%' : 'Desligado')}
        ${tile('dnd', 'bell-off', 'Não perturbe', S.dnd ? 'Só o urgente' : 'Desligado')}
        <button class="tile" data-act="dark-toggle" aria-pressed="${isDark()}">${icon(isDark() ? 'moon' : 'sun', 18)}<span class="grow"><div class="t">Tema escuro</div><div class="s">${S.theme === 'sistema' ? 'Pelo sistema' : isDark() ? 'Ligado' : 'Desligado'}</div></span></button>
      </div>
      <div class="group">
        <div class="sl">${icon('volume-2')}${slider('volume', 'Volume')}</div>
        <div class="sl">${icon('sun')}${slider('bright', 'Brilho')}</div>
      </div>
    </div>
    <div class="foot">${icon('battery-medium', 14)}<span class="num" style="color:var(--foreground)">${S.battery}%</span><span>3 h 40 min</span><span class="grow"></span><span>${bytes(DISK_TOTAL - S.diskUsed)} livres</span></div>
    </div>`
}

function toggleQuick() {
  if (overlay === 'quick') return closeOverlay()
  overlay = 'quick'
  renderQuick()
  renderRail()
}

/* O início: apps, ações e conversas, com a busca no alto; o que não achar vira um pedido ao Claude. */
let launch = { q: '', i: 0, items: [] }
function launcherItems(q) {
  const apps = RAIL_APPS.map((a) => ({ group: 'Apps', lead: APPS[a].glyph().replace('width="20" height="20"', 'width="16" height="16"'), title: APPS[a].title, meta: '', run: () => WM.open(a) }))
  const acts = [
    { group: 'Ações', lead: icon(isDark() ? 'sun' : 'moon'), title: isDark() ? 'Tema claro' : 'Tema escuro', run: () => setTheme(isDark() ? 'claro' : 'escuro') },
    { group: 'Ações', lead: icon('columns-2'), title: 'Lado a lado', meta: 'as duas de cima', run: () => WM.tile() },
    { group: 'Ações', lead: icon('download'), title: 'Abrir Downloads', run: () => openFiles('downloads') },
    { group: 'Ações', lead: icon('lock'), title: 'Bloquear tela', run: () => lock() },
    { group: 'Ações', lead: icon('power'), title: 'Desligar', run: () => powerOff() },
  ]
  const chats = [
    ...S.chats.map((c) => ({ group: 'Conversas', lead: claudinho(c.seed, { size: 18, state: chatState(c), status: true }), title: c.title, meta: c === mainChat() ? 'agora' : '', run: () => openChat(c) })),
    { group: 'Conversas', lead: claudinho('conversa:tailnet', { size: 18 }), title: 'Configurar a tailnet', meta: '2 h', run: () => openPast('Configurar a tailnet', 'conversa:tailnet', 'Coloca o celular na tailnet', 'Feito: o celular entrou como pixel-9, e o cald responde em :10000 por lá.') },
    { group: 'Conversas', lead: claudinho('conversa:dotfiles', { size: 18 }), title: 'Arrumar os dotfiles', meta: 'ontem', run: () => openPast('Arrumar os dotfiles', 'conversa:dotfiles', 'Junta meus dotfiles num repo', 'Juntei zsh, git e o Hyprland em ~/dotfiles, com um link para cada. Nada saiu do lugar.') },
  ]
  const all = [...apps, ...acts, ...chats]
  if (!q) return all
  const nq = norm(q)
  const hits = all.filter((x) => norm(x.title).includes(nq))
  return [...hits, { group: 'Claude', lead: claudeMark(16), title: `Perguntar: “${q}”`, meta: '', run: () => openChat(chatNow(), q) }]
}
function openChat(c, text) {
  S.chatTab = c.id
  WM.open('claude')
  refresh('claude')
  if (text) ask(c, text)
}
function openPast(title, seed, q, a) {
  let c = S.chats.find((x) => x.seed === seed)
  if (!c) {
    c = newChat(title, seed)
    push(c, { t: 'user', text: q })
    push(c, { t: 'text', html: `<p>${esc(a)}</p>` })
  }
  openChat(c)
}

function renderLauncherList() {
  const box = $('.launcher .list')
  if (!box) return
  launch.items = launcherItems(launch.q)
  launch.i = Math.min(launch.i, launch.items.length - 1)
  let g = ''
  box.innerHTML = launch.items
    .map((x, i) => {
      const head = x.group !== g ? `<h3>${x.group}</h3>` : ''
      g = x.group
      return `${head}<button class="row" role="option" data-act="launch-item" data-i="${i}" aria-selected="${i === launch.i}">${x.lead}<span class="grow truncate">${esc(x.title)}</span>${x.meta ? `<span class="meta">${esc(x.meta)}</span>` : ''}</button>`
    })
    .join('')
  $('[aria-selected="true"]', box)?.scrollIntoView({ block: 'nearest' })
}

function openLauncher(q = '') {
  overlay = 'launcher'
  launch = { q, i: 0, items: [] }
  $('#overlay').innerHTML = `<div class="veil" data-act="close-overlay"></div>
    <div class="launcher" role="dialog" aria-label="Início"><div class="pane">
      <label class="q">${icon('search', 18)}<input placeholder="Buscar apps, ações ou pedir ao Claude" aria-label="Buscar" value="${esc(q)}" /></label>
      <div class="list scroll" role="listbox"></div>
    </div>
    <div class="foot"><span><span class="kbd">↑</span><span class="kbd">↓</span>escolher</span><span><span class="kbd">${icon('corner-down-left', 11)}</span>abrir</span><span><span class="kbd">esc</span>fechar</span></div>
    </div>`
  const inp = $('.launcher input')
  inp.addEventListener('input', () => {
    launch.q = inp.value
    launch.i = 0
    renderLauncherList()
  })
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      launch.i = (launch.i + (e.key === 'ArrowDown' ? 1 : -1) + launch.items.length) % launch.items.length
      renderLauncherList()
      e.preventDefault()
    } else if (e.key === 'Enter') {
      runLaunch(launch.i)
      e.preventDefault()
    }
  })
  renderLauncherList()
  renderRail()
  inp.focus()
}
function runLaunch(i) {
  const it = launch.items[i]
  closeOverlay()
  it?.run()
}

/* Avisos, como os do app (sonner): curtos, com uma ação e sumindo sozinhos. */
function toast({ lead = '', title, desc = '', action, ms = 5200 }) {
  if (S.dnd && !action) return
  const el = document.createElement('div')
  el.className = 'toast'
  el.innerHTML = `${lead}<div class="grow"><div class="t">${esc(title)}</div>${desc ? `<div class="d">${esc(desc)}</div>` : ''}</div>${action ? `<button class="btn btn-ghost">${esc(action.label)}</button>` : ''}`
  const bye = () => {
    el.classList.add('out')
    setTimeout(() => el.remove(), 200)
  }
  if (action)
    $('button', el).onclick = () => {
      action.fn()
      bye()
    }
  $('#toasts').append(el)
  setTimeout(bye, ms)
  return { el, bye }
}

/* ---------------------------------------------------------------- Bloqueio e desligar */

let pin = ''
function renderLock() {
  const now = new Date()
  const el = $('#lock')
  if (!el.childElementCount) {
    el.innerHTML = `
      <div style="text-align:center"><div class="time"></div><div class="date"></div></div>
      <div class="who">${claudinho(ME, { size: 56 })}<b>${ME}</b></div>
      <div class="pin" aria-label="PIN">${'<i></i>'.repeat(4)}</div>
      <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-act="digit" data-d="${n}">${n}</button>`).join('')}<button class="blank" tabindex="-1" aria-hidden="true"></button><button data-act="digit" data-d="0">0</button><button data-act="backspace" aria-label="Apagar">${icon('delete', 20)}</button></div>
      <div class="hint">Qualquer PIN de 4 dígitos</div>`
  }
  $('.time', el).textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  $('.date', el).textContent = now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
  $$('.pin i', el).forEach((d, i) => d.classList.toggle('on', i < pin.length))
}
function typePin(d) {
  if (!S.locked || pin.length >= 4) return
  pin += d
  renderLock()
  if (pin.length === 4) setTimeout(unlock, 180)
}

let booted = false
function unlock() {
  S.locked = false
  pin = ''
  $('#lock').classList.add('out')
  $('#desktop').classList.add('on')
  if (!booted) {
    booted = true
    WM.open('files', { background: true })
    setTimeout(() => WM.open('term', { background: true }), 90)
    setTimeout(() => {
      WM.open('claude')
      renderPulse()
    }, 180)
  } else renderPulse()
  renderRail()
  setTimeout(renderLock, 400)
}
function lock() {
  closeOverlay()
  S.locked = true
  pin = ''
  renderLock()
  renderPulse()
  $('#desktop').classList.remove('on')
  $('#lock').classList.remove('out')
  $('#lock').focus()
}

/* Desligar tem volta: dez segundos para cancelar, como tudo o que o cald apaga. */
let powerTimer = null
function powerOff() {
  closeOverlay()
  if (powerTimer) return
  let left = 10
  const t = toast({ lead: icon('power', 18, 'muted'), title: 'Desligando em 10 s', desc: 'As janelas fecham sozinhas', action: { label: 'Cancelar', fn: cancel }, ms: 11000 })
  function cancel() {
    clearInterval(powerTimer)
    powerTimer = null
  }
  powerTimer = setInterval(() => {
    left--
    $('.t', t.el).textContent = `Desligando em ${left} s`
    if (left <= 0) {
      cancel()
      t.bye()
      const off = document.createElement('div')
      off.className = 'off'
      off.innerHTML = `<button title="Ligar" aria-label="Ligar">${icon('power', 28)}</button>`
      $('button', off).onclick = () => {
        off.remove()
        lock()
      }
      document.body.append(off)
    }
  }, 1000)
}

/* ---------------------------------------------------------------- Ações */

const ACTIONS = {
  min: (_, w) => WM.minimize(w),
  max: (_, w) => WM.toggleMax(w),
  close: (_, w) => WM.close(w),
  rail(el) {
    const a = el.dataset.app
    const w = WM.wins.get(a)
    if (w && !w.min && WM.focused === w) WM.minimize(w)
    else WM.open(a)
  },
  tab(el, w) {
    const id = el.dataset.id
    if (w.app === 'claude') S.chatTab = id
    if (w.app === 'term') S.term.tab = id
    if (w.app === 'web') S.web.tab = id
    renderWin(w)
  },
  tabclose(el, w, e) {
    e.stopPropagation()
    const id = el.dataset.id
    if (w.app === 'term') return closeTermTab(id)
    if (w.app === 'web') {
      S.web.tabs = S.web.tabs.filter((t) => t.id !== id)
      if (!S.web.tabs.length) return WM.close(w)
      if (S.web.tab === id) S.web.tab = S.web.tabs.at(-1).id
    }
    if (w.app === 'claude') {
      const i = S.chats.findIndex((c) => c.id === id)
      if (i <= 0) return
      S.chats.splice(i, 1)
      if (S.chatTab === id) S.chatTab = S.chats[Math.max(0, i - 1)].id
    }
    renderWin(w)
  },
  newtab(_, w) {
    if (w.app === 'claude') S.chatTab = newChat().id
    if (w.app === 'term') newTermTab()
    if (w.app === 'web') {
      const id = nextId('w')
      S.web.tabs.push({ id, title: 'Nova aba', url: '' })
      S.web.tab = id
    }
    renderWin(w)
    if (w.app === 'claude') $('textarea', w.el).focus()
    if (w.app === 'term') $('.prompt input', w.el).focus()
    if (w.app === 'web') $('[data-search] input', w.el)?.focus()
  },
  allow,
  deny,
  stop: (_, __, e) => {
    e.stopPropagation()
    stopClaude()
  },
  pulse() {
    const c = mainChat()
    openChat(c)
    if (S.claude.phase === 'waiting') setTimeout(() => $('[data-approval]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60)
  },
  suggest: (el) => ask(chatNow(), el.dataset.text),
  fview(el) {
    S.files.view = el.dataset.id
    S.files.sel = null
    S.files.q = ''
    refresh('files')
  },
  fsel(el) {
    S.files.sel = el.dataset.file
    $$('.file-row', el.parentElement).forEach((r) => r.setAttribute('aria-selected', r === el))
  },
  fsearch() {
    S.files.search = !S.files.search
    S.files.q = ''
    S.files.justOpened = S.files.search
    refresh('files')
  },
  restore: (el, _, e) => {
    e.stopPropagation()
    restore(el.dataset.file)
  },
  'empty-trash'() {
    const gone = S.trash
    S.trash = []
    refresh('files')
    toast({
      lead: icon('trash', 18, 'muted'),
      title: 'Lixeira esvaziada',
      desc: `${gone.length} ${gone.length === 1 ? 'item' : 'itens'}`,
      action: {
        label: 'Desfazer',
        fn: () => {
          S.trash = [...gone, ...S.trash]
          refresh('files')
        },
      },
    })
  },
  sview(el) {
    S.settings.view = el.dataset.id
    refresh('settings')
  },
  seg(el) {
    const { key, val } = el.dataset
    if (key === 'theme') return setTheme(val)
    if (key === 'scene') {
      S.scene = val === 'ondas'
      Cena.setOn(S.scene && !S.calm)
    } else S[key] = val
    refreshAll()
  },
  toggle(el) {
    const key = el.dataset.key
    S[key] = !S[key]
    if (key === 'calm') {
      document.documentElement.classList.toggle('calm', S.calm)
      Cena.setStill(S.calm)
    }
    refreshAll()
  },
  'dark-toggle': () => setTheme(isDark() ? 'claro' : 'escuro'),
  net(el) {
    S.net = el.dataset.id
    refreshAll()
  },
  reroll: () => Cena.reroll(),
  shortcut(el) {
    const s = SHORTCUTS[+el.dataset.i]
    go(s.url)
  },
  'web-home'() {
    const t = webNow()
    t.url = ''
    t.title = 'Nova aba'
    refresh('web')
  },
  launcher: () => (overlay === 'launcher' ? closeOverlay() : openLauncher()),
  'launch-item': (el) => runLaunch(+el.dataset.i),
  quick: () => toggleQuick(),
  disk: () => openFiles('downloads'),
  'close-overlay': () => closeOverlay(),
  'open-settings'() {
    closeOverlay()
    WM.open('settings')
  },
  lock: () => lock(),
  power: () => powerOff(),
  digit: (el) => typePin(el.dataset.d),
  backspace() {
    pin = pin.slice(0, -1)
    renderLock()
  },
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]')
  if (!el || el.disabled) return
  const winEl = el.closest('.win')
  const w = winEl ? WM.wins.get(winEl.dataset.app) : null
  ACTIONS[el.dataset.act]?.(el, w, e)
})
document.addEventListener('dblclick', (e) => {
  const row = e.target.closest('.file-row[data-project]')
  if (!row) return
  const p = S.projects.find((x) => x.name === row.dataset.file)
  if (!p) return
  WM.open('term')
  newTermTab(`~/Projects/${p.name}`, p.branch, p.name)
  refresh('term')
})
document.addEventListener('input', (e) => {
  const el = e.target
  if (!el.classList.contains('slider')) return
  S[el.dataset.key] = +el.value
  el.style.setProperty('--v', `${el.value}%`)
  const label = $(`[data-val="${el.dataset.key}"]`)
  if (label) label.textContent = `${el.value}%`
  // O mesmo controle no painel rápido e nos Ajustes.
  $$(`.slider[data-key="${el.dataset.key}"]`).forEach((o) => {
    if (o !== el) {
      o.value = el.value
      o.style.setProperty('--v', `${el.value}%`)
    }
  })
})
document.addEventListener('keydown', (e) => {
  if (S.locked) {
    if (/^\d$/.test(e.key)) typePin(e.key)
    else if (e.key === 'Backspace') ACTIONS.backspace()
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    overlay === 'launcher' ? closeOverlay() : openLauncher()
  } else if (e.altKey && e.code === 'Space') {
    e.preventDefault()
    openLauncher()
  } else if (e.key === 'Escape' && overlay) {
    closeOverlay()
  }
})
// A tecla Super sozinha abre o início, como no GNOME.
let superAlone = false
document.addEventListener('keydown', (e) => (superAlone = e.key === 'Meta'))
document.addEventListener('keyup', (e) => {
  if (e.key === 'Meta' && superAlone && !S.locked) overlay === 'launcher' ? closeOverlay() : openLauncher()
  superAlone = false
})

/* ---------------------------------------------------------------- Relógio e medidas */

setInterval(() => {
  // O processador acompanha o Claude: trabalhando, ele sobe.
  const target = S.claude.phase === 'running' ? 72 : 16
  S.cpu = Math.max(3, Math.min(98, S.cpu + (target - S.cpu) * 0.35 + (Math.random() - 0.5) * 8))
  S.ram = Math.max(40, Math.min(80, S.ram + (Math.random() - 0.5) * 1.5))
  if (!S.locked) renderRail()
  else renderLock()
}, 2000)
setInterval(() => {
  if (S.claude.phase === 'running') renderPulse()
  if (S.claude.phase === 'running' || chatNow()?.busy) renderWorking()
}, 1000)

/* ---------------------------------------------------------------- Início */

if (params.get('tema')) S.theme = params.get('tema')
seedChats()
seedTerm()
Cena.mount($('#cena'))
applyTheme()
document.fonts?.load("600 10px 'Cascadia Code Variable'").then(() => Cena.setDark(isDark()))
renderLock()
renderRail()
if (params.has('desbloqueado')) unlock()
else $('#lock').focus()
