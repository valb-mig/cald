import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HttpError } from './errors.ts';
import { TranscriptTally, transcriptPath } from './transcript.ts';

/**
 * Preço em US$ por milhão de tokens e janela de contexto de cada modelo, da tabela oficial
 * (https://platform.claude.com/docs/en/about-claude/pricing, consultada em 23/10/2026).
 * Gravar no cache custa 1,25× a entrada (cache de 5 min) ou 2× (1 h); ler dele, a fração
 * `cacheRead` da entrada. Modelo que não estiver aqui aparece com os tokens, mas sem custo.
 */
export type Model = { input: number; output: number; cacheRead: number; window: number; over100k?: { input: number; output: number } };

const MI = 1_000_000;
const K200 = 200_000;
export const MODELS: Record<string, Model> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.025, window: MI },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.025, window: MI },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 0.1, window: MI },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 0.1, window: MI },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.05, window: MI },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.1, window: MI },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.1, window: MI },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.1, window: MI },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.1, window: MI },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.1, window: K200 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 0.1, window: K200 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 0.1, window: K200 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.05, window: MI },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.1, window: MI },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.1, window: MI },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.1, window: K200 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.1, window: K200 },
  // Prompt (entrada + cache) acima de 100 mil tokens paga a tabela mais cara.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.1, window: MI, over100k: { input: 0.5, output: 2.5 } },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, window: K200 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.1, window: K200 },
};
// Modo rápido (só Opus 5.5, 5 e 4.8) custa o dobro; inferência só nos EUA, 10% a mais.
const FAST = 2;
const US_ONLY = 1.1;
const WEB_SEARCH_USD = 10 / 1000;

/** `claude-haiku-4-5-20251001` → `claude-haiku-4-5`; `claude-opus-5-5[1m]` → `claude-opus-5-5`. */
export const canonical = (model: string) => model.replace(/\[\w+\]$/, '').replace(/-\d{8}$/, '');

/** `usage` de uma resposta, como o Claude Code grava no transcript. */
export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  server_tool_use?: { web_search_requests?: number };
  speed?: string;
  inference_geo?: string;
};

export function costOf(m: Model, u: Usage): number {
  const write = u.cache_creation_input_tokens ?? 0;
  // Sem o detalhe por duração (versões antigas), a gravação conta como de 5 min.
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const prompt = (u.input_tokens ?? 0) + write + read;
  const { input, output } = m.over100k && prompt > 100_000 ? m.over100k : m;
  const perMillion =
    (u.input_tokens ?? 0) * input +
    (write - write1h) * input * 1.25 +
    write1h * input * 2 +
    read * input * m.cacheRead +
    (u.output_tokens ?? 0) * output;
  const multiplier = (u.speed === 'fast' ? FAST : 1) * (u.inference_geo === 'us' ? US_ONLY : 1);
  return (perMillion / MI) * multiplier + (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
}

export type ModelSpend = {
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** null: modelo sem preço na tabela. */
  costUsd: number | null;
};

export type SessionCost = {
  /** Soma dos modelos com preço, subagentes incluídos. */
  costUsd: number;
  /** Parte do custo que veio de subagentes. */
  subagentsUsd: number;
  /** Maior custo primeiro. */
  models: ModelSpend[];
  /** Tamanho do contexto na última resposta da conversa principal. */
  context: { model: string; tokens: number; window: number | null } | null;
};

type FileSpend = {
  models: Map<string, ModelSpend>;
  subagentsUsd: number;
  last: { model: string; requested?: string; usage: Usage } | null;
  subagent: boolean;
  /** Respostas já contadas (ver `addLine`). */
  seen: Set<string>;
};

type Entry = {
  type?: string;
  isSidechain?: boolean;
  requestedModel?: string;
  message?: { id?: string; model?: string; usage?: Usage };
};

/**
 * Soma o `usage` de uma linha do transcript. O Claude Code grava uma linha por bloco da
 * resposta, todas com o mesmo `usage`: cada mensagem conta uma vez só.
 */
function addLine(spend: FileSpend, line: string): void {
  if (!line.includes('"usage"')) return;
  let entry: Entry;
  try {
    entry = JSON.parse(line) as Entry;
  } catch {
    return;
  }
  const msg = entry.message;
  // `<synthetic>`: avisos que o próprio Claude Code escreve no lugar de uma resposta.
  if (entry.type !== 'assistant' || !msg?.usage || !msg.model || msg.model === '<synthetic>') return;
  if (msg.id) {
    if (spend.seen.has(msg.id)) return;
    spend.seen.add(msg.id);
  }
  const u = msg.usage;
  const model = canonical(msg.model);
  const price = MODELS[model];
  const s = spend.models.get(model) ?? {
    model,
    requests: 0,
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    costUsd: price ? 0 : null,
  };
  s.requests += 1;
  s.input += u.input_tokens ?? 0;
  s.output += u.output_tokens ?? 0;
  s.cacheWrite += u.cache_creation_input_tokens ?? 0;
  s.cacheRead += u.cache_read_input_tokens ?? 0;
  if (price) {
    const usd = costOf(price, u);
    s.costUsd! += usd;
    // Transcripts antigos guardavam os subagentes no arquivo da sessão, marcados como `isSidechain`.
    if (spend.subagent || entry.isSidechain) spend.subagentsUsd += usd;
  }
  spend.models.set(model, s);
  if (!spend.subagent && !entry.isSidechain) spend.last = { model, requested: entry.requestedModel, usage: u };
}

// A soma de cada transcript fica guardada e, quando ele cresce, só o trecho novo é lido.
const spends = new TranscriptTally(addLine);

const fileSpend = (path: string, subagent: boolean) =>
  spends.read(path, (): FileSpend => ({ models: new Map(), subagentsUsd: 0, last: null, subagent, seen: new Set() }));

/** Transcript da sessão e os dos subagentes: ~/.claude/projects/<projeto>/<sessão>.jsonl e <sessão>/subagents/agent-*.jsonl. */
async function transcripts(sessionId: string): Promise<{ main: string; subagents: string[] } | null> {
  const main = await transcriptPath(sessionId);
  if (!main) return null;
  const dir = join(dirname(main), sessionId, 'subagents');
  const names = await readdir(dir).catch(() => []);
  return { main, subagents: names.filter((n) => n.endsWith('.jsonl')).map((n) => join(dir, n)) };
}

/**
 * Tokens e custo da conversa inteira, lidos dos transcripts salvos: servem para qualquer
 * sessão, aberta no painel, no PC ou só no histórico. O custo é o preço de tabela da API.
 */
export async function sessionCost(sessionId: string): Promise<SessionCost> {
  const files = await transcripts(sessionId);
  if (!files) throw new HttpError(404, 'transcript_not_found');
  const [main, ...subs] = await Promise.all([fileSpend(files.main, false), ...files.subagents.map((p) => fileSpend(p, true))]);

  const models = new Map<string, ModelSpend>();
  for (const spend of [main!, ...subs]) {
    for (const s of spend.models.values()) {
      const acc = models.get(s.model);
      if (!acc) {
        models.set(s.model, { ...s });
        continue;
      }
      acc.requests += s.requests;
      acc.input += s.input;
      acc.output += s.output;
      acc.cacheWrite += s.cacheWrite;
      acc.cacheRead += s.cacheRead;
      if (acc.costUsd !== null) acc.costUsd += s.costUsd!;
    }
  }
  const list = [...models.values()].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1));

  const last = main!.last;
  const u = last?.usage;
  return {
    costUsd: list.reduce((sum, m) => sum + (m.costUsd ?? 0), 0),
    subagentsUsd: [main!, ...subs].reduce((sum, s) => sum + s.subagentsUsd, 0),
    models: list,
    context:
      last && u
        ? {
            model: last.model,
            // O que foi enviado mais a resposta, que entra na próxima chamada.
            tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0),
            window: last.requested?.endsWith('[1m]') ? MI : (MODELS[last.model]?.window ?? null),
          }
        : null,
  };
}
