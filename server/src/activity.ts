import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ACTIVITY_FILE, CLAUDE_HOME } from './config.ts';
import { MODELS, canonical, costOf, type Usage } from './session-cost.ts';
import { TranscriptTally } from './transcript.ts';

/**
 * Histórico de uso por dia, para a home: conversas (todas e só as pelo cald), mensagens
 * suas, tokens e custo estimado, horários e projetos. Sai dos transcripts em ~/.claude/projects,
 * que o Claude Code apaga depois de ~30 dias; por isso o que foi lido fica guardado num arquivo
 * próprio, e o grid do ano não perde os dias cujos transcripts já sumiram.
 */

/** O que uma conversa fez num dia. Chaves curtas: o arquivo guarda anos disso. */
type SessionDay = {
  /** Mensagens suas. */
  p: number;
  /** Usada pelo cald (o Agent SDK do painel) nesse dia. */
  r?: 1;
  /** Custo estimado (US$) e tokens processados, subagentes incluídos. */
  c: number;
  t: number;
  /** Mensagens suas por hora do dia (só as horas com alguma). */
  h?: Record<number, number>;
  /** Pasta do projeto. */
  w?: string;
  /** Só do histórico de mensagens do terminal (transcript já apagado): sem custo nem tokens. */
  o?: 1;
};
/** dia (AAAA-MM-DD, hora local) → conversa → o que ela fez nele. */
type Days = Record<string, Record<string, SessionDay>>;
type Store = { v: 1; days: Days };

export type ActivityDay = { date: string; sessions: number; remote: number; prompts: number; costUsd: number; tokens: number };
export type ActivityProject = { cwd: string; sessions: number; prompts: number; costUsd: number; tokens: number };
export type Activity = {
  /** Só os dias com alguma atividade, do mais antigo ao mais novo. */
  days: ActivityDay[];
  /** Mensagens suas por dia da semana (0 = domingo) e hora, nos últimos 30 dias. */
  hours: number[][];
  /** Projetos dos últimos 30 dias, do que mais custou ao que menos. */
  projects: ActivityProject[];
};

type Line = {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  entrypoint?: string;
  cwd?: string;
  promptSource?: string;
  origin?: { kind?: string };
  message?: { id?: string; model?: string; usage?: Usage; content?: unknown };
};

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Mensagem escrita por você: não resultado de ferramenta, aviso de tarefa ou texto do sistema. */
function isPrompt(e: Line): boolean {
  if (e.type !== 'user' || e.isSidechain || e.isMeta) return false;
  if (e.promptSource === 'system' || (e.origin?.kind && e.origin.kind !== 'human')) return false;
  const c = e.message?.content;
  if (typeof c === 'string') return c.trim().length > 0;
  return Array.isArray(c) && c.some((b: { type?: string }) => b?.type === 'text' || b?.type === 'image');
}

/** Um transcript, dia a dia. Subagentes só somam custo e tokens (a conversa é a do pai). */
type TranscriptDays = {
  days: Map<string, SessionDay>;
  subagent: boolean;
  // O Claude Code grava uma linha por bloco da resposta, todas com o mesmo `usage`.
  seen: Set<string>;
};

function addLine(s: TranscriptDays, line: string): void {
  // Resultados de ferramentas são a maior parte do arquivo e não dizem nada que a resposta não diga.
  if (line.includes('"tool_result"') || !line.includes('"timestamp"')) return;
  let e: Line;
  try {
    e = JSON.parse(line) as Line;
  } catch {
    return;
  }
  if ((e.type !== 'user' && e.type !== 'assistant') || !e.timestamp) return;
  const when = new Date(e.timestamp);
  if (Number.isNaN(when.getTime())) return;
  const key = dayKey(when);
  let day = s.days.get(key);
  if (!day) s.days.set(key, (day = { p: 0, c: 0, t: 0 }));

  if (!s.subagent) {
    if (e.entrypoint === 'sdk-ts') day.r = 1;
    if (e.cwd && !day.w) day.w = e.cwd;
    if (isPrompt(e)) {
      const h = (day.h ??= {});
      h[when.getHours()] = (h[when.getHours()] ?? 0) + 1;
      day.p++;
    }
  }
  const msg = e.message;
  if (e.type !== 'assistant' || !msg?.usage || !msg.model || msg.model === '<synthetic>') return;
  if (msg.id) {
    if (s.seen.has(msg.id)) return;
    s.seen.add(msg.id);
  }
  const u = msg.usage;
  day.t += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const price = MODELS[canonical(msg.model)];
  if (price) day.c += costOf(price, u);
}

type Transcript = { path: string; session: string; subagent: boolean };

/** ~/.claude/projects/<projeto>/<sessão>.jsonl e <sessão>/subagents/agent-*.jsonl. */
async function transcripts(): Promise<Transcript[]> {
  const root = join(CLAUDE_HOME, 'projects');
  const out: Transcript[] = [];
  for (const project of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push({ path: join(dir, entry.name), session: entry.name.slice(0, -6), subagent: false });
      } else if (entry.isDirectory()) {
        const sub = join(dir, entry.name, 'subagents');
        for (const name of await readdir(sub).catch(() => [])) {
          if (name.endsWith('.jsonl')) out.push({ path: join(sub, name), session: entry.name, subagent: true });
        }
      }
    }
  }
  return out;
}

// O que cada transcript fez fica guardado e, quando ele cresce, só o trecho novo é lido.
const scanned = new TranscriptTally(addLine);

async function daysOf(t: Transcript): Promise<Map<string, SessionDay>> {
  const s = await scanned.read(t.path, (): TranscriptDays => ({ days: new Map(), subagent: t.subagent, seen: new Set() }));
  return s.days;
}

let store: Store | null = null;
let saved = '';

async function load(): Promise<Store> {
  if (store) return store;
  try {
    const raw = await readFile(ACTIVITY_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Store;
    store = parsed?.v === 1 && parsed.days ? parsed : { v: 1, days: {} };
    saved = raw;
  } catch {
    store = { v: 1, days: {} };
  }
  return store;
}

async function persist(s: Store): Promise<void> {
  const text = JSON.stringify(s);
  if (text === saved) return;
  await mkdir(dirname(ACTIVITY_FILE), { recursive: true });
  // Escreve ao lado e troca: um desligamento no meio não corrompe o histórico.
  await writeFile(`${ACTIVITY_FILE}.tmp`, text);
  await rename(`${ACTIVITY_FILE}.tmp`, ACTIVITY_FILE);
  saved = text;
}

type PromptLine = { timestamp?: number; sessionId?: string; project?: string };

/**
 * Dias de antes dos transcripts que ainda existem: o histórico de mensagens do terminal
 * (~/.claude/history.jsonl, o da seta para cima) diz quando e em que conversa você escreveu.
 * Não entra o que já se sabe melhor pelos transcripts, nem o que já foi guardado deles.
 */
async function fromPromptHistory(s: Store, known: Set<string>): Promise<void> {
  const raw = await readFile(join(CLAUDE_HOME, 'history.jsonl'), 'utf8').catch(() => '');
  const seeded = new Map<string, SessionDay>();
  for (const line of raw.split('\n')) {
    let e: PromptLine;
    try {
      e = JSON.parse(line) as PromptLine;
    } catch {
      continue;
    }
    if (!e.sessionId || !e.timestamp || known.has(e.sessionId)) continue;
    const when = new Date(e.timestamp);
    if (Number.isNaN(when.getTime())) continue;
    const key = `${dayKey(when)}|${e.sessionId}`;
    const day = seeded.get(key) ?? { p: 0, c: 0, t: 0, o: 1 as const, w: e.project };
    const h = (day.h ??= {});
    h[when.getHours()] = (h[when.getHours()] ?? 0) + 1;
    day.p++;
    seeded.set(key, day);
  }
  for (const [key, d] of seeded) {
    const [date, session] = key.split('|');
    const stored = s.days[date]?.[session];
    if (stored && !stored.o) continue;
    (s.days[date] ??= {})[session] = d;
  }
}

/** Relê os transcripts que mudaram e atualiza o histórico guardado. */
async function refresh(): Promise<Store> {
  const s = await load();
  const files = await transcripts();
  const results = await Promise.all(files.map((f) => daysOf(f).then((days) => ({ f, days }), () => null)));

  // Cada conversa com transcript ainda no disco é refeita do zero (o pai mais os subagentes);
  // as que já sumiram ficam como estavam.
  const fresh = new Map<string, Map<string, SessionDay>>();
  for (const r of results) {
    if (!r) continue;
    const sessionDays = fresh.get(r.f.session) ?? new Map<string, SessionDay>();
    fresh.set(r.f.session, sessionDays);
    for (const [key, d] of r.days) {
      const into = sessionDays.get(key);
      if (!into) {
        sessionDays.set(key, { ...d, h: d.h && { ...d.h } });
        continue;
      }
      into.c += d.c;
      into.t += d.t;
      into.p += d.p;
      if (d.r) into.r = 1;
      into.w ??= d.w;
      for (const [hour, n] of Object.entries(d.h ?? {})) (into.h ??= {})[+hour] = (into.h[+hour] ?? 0) + n;
    }
  }
  for (const day of Object.values(s.days)) for (const session of fresh.keys()) delete day[session];
  for (const [session, sessionDays] of fresh) {
    for (const [key, d] of sessionDays) (s.days[key] ??= {})[session] = { ...d, c: Math.round(d.c * 1e4) / 1e4 };
  }
  await fromPromptHistory(s, new Set(fresh.keys()));
  for (const [key, day] of Object.entries(s.days)) if (Object.keys(day).length === 0) delete s.days[key];
  await persist(s);
  return s;
}

/** O resumo do uso; com `cwd`, só o das conversas daquele projeto (o hub do projeto, no app). */
function summarize(s: Store, cwd?: string): Activity {
  const since = new Date();
  since.setDate(since.getDate() - 29);
  const recent = dayKey(since);
  const hours = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const projects = new Map<string, ActivityProject & { ids: Set<string> }>();

  const days = Object.keys(s.days)
    .sort()
    .flatMap((date): ActivityDay[] => {
      const sessions = Object.entries(s.days[date]).filter(([, d]) => !cwd || d.w === cwd);
      // Só os dias com alguma atividade: filtrado por projeto, muitos ficam vazios.
      if (!sessions.length) return [];
      const day: ActivityDay = { date, sessions: sessions.length, remote: 0, prompts: 0, costUsd: 0, tokens: 0 };
      // Meio-dia: o dia da semana não muda com horário de verão.
      const weekday = new Date(`${date}T12:00:00`).getDay();
      for (const [id, d] of sessions) {
        day.remote += d.r ? 1 : 0;
        day.prompts += d.p;
        day.costUsd += d.c;
        day.tokens += d.t;
        if (date < recent) continue;
        for (const [hour, n] of Object.entries(d.h ?? {})) hours[weekday][+hour] += n;
        const cwd = d.w ?? '';
        const p = projects.get(cwd) ?? { cwd, sessions: 0, prompts: 0, costUsd: 0, tokens: 0, ids: new Set<string>() };
        p.ids.add(id);
        p.prompts += d.p;
        p.costUsd += d.c;
        p.tokens += d.t;
        projects.set(cwd, p);
      }
      day.costUsd = Math.round(day.costUsd * 100) / 100;
      return [day];
    });

  return {
    days,
    hours,
    projects: [...projects.values()]
      .filter((p) => p.cwd)
      .map(({ ids, ...p }) => ({ ...p, sessions: ids.size, costUsd: Math.round(p.costUsd * 100) / 100 }))
      .sort((a, b) => b.costUsd - a.costUsd),
  };
}

// A home e o hub de cada projeto pedem de novo a cada abertura: dentro de meio minuto, vale a última
// leitura dos transcripts; o resumo (de tudo ou de um projeto) sai dela na hora.
const FRESH_MS = 30_000;
let last: { at: number; store: Promise<Store> } | null = null;

/** O uso do app inteiro ou, com `cwd`, só o das conversas daquele projeto. */
export async function activity(cwd?: string): Promise<Activity> {
  if (!last || Date.now() - last.at >= FRESH_MS) {
    const store = refresh();
    last = { at: Date.now(), store };
    store.catch(() => (last = null));
  }
  return summarize(await last.store, cwd);
}
