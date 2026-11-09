// Cliente de linha de comando da PoC: faz o papel do celular contra o backend.
// Uso: node scripts/poc-client.ts <comando> [args] [--flags]
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';

const BASE = process.env.EDITR_URL ?? 'http://127.0.0.1:7337';

const { positionals, values: flags } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string' },
    effort: { type: 'string' },
    mode: { type: 'string' },
    fork: { type: 'boolean' },
    deny: { type: 'boolean' },
    always: { type: 'boolean' },
    since: { type: 'string' },
    answer: { type: 'string' }, // allow | deny | ask (padrão: ask)
    pick: { type: 'string' }, // opção usada nas perguntas quando --answer allow (padrão: 1)
    until: { type: 'string' }, // idle | exit
    timeout: { type: 'string' },
  },
});

const [command, ...args] = positionals;

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`HTTP ${res.status}`, JSON.stringify(data));
    process.exit(1);
  }
  return data;
}

const runOpts = () => ({ model: flags.model, effort: flags.effort, permissionMode: flags.mode });

type Entry = { sessionId: string; title: string; cwd?: string; owner: string | null; state: string; waitingFor?: string; lastModified: number };
type Ev = { seq: number; kind: string; [k: string]: unknown };
type Q = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };

function fmtEvent(e: Ev): string {
  const one = (s: unknown, n = 160) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
  switch (e.kind) {
    case 'user': return `👤 ${one(e.text, 400)}`;
    case 'assistant': return `🤖 ${one(e.text, 400)}`;
    case 'thinking': return `💭 ${one(e.text, 80)}`;
    case 'tool_use': return `🔧 ${e.name} ${one(JSON.stringify(e.input))}`;
    case 'tool_result': return `   ↳ ${e.isError ? 'ERRO ' : ''}${one(e.text)}`;
    case 'state': return `◆ estado: ${e.state}${e.waitingFor ? ` (${e.waitingFor})` : ''}`;
    case 'approval_request': return `⚠️  aprovação ${e.requestId}: ${e.title ?? e.toolName} ${one(JSON.stringify(e.input))}`;
    case 'approval_resolved': return `✔ aprovação ${e.requestId}: ${e.decision}`;
    case 'question_request': return `❓ pergunta ${e.requestId}: ${(e.questions as Q[]).map((q) => q.question).join(' | ')}`;
    case 'question_resolved': return `✔ pergunta ${e.requestId}: ${e.decision}${e.answers ? ` ${JSON.stringify(e.answers)}` : ''}`;
    case 'result': return `■ fim do turno: ${e.subtype} · ${e.turns} turnos · ${e.durationMs}ms`;
    case 'init': return `▶ init: ${e.model} · modo ${e.permissionMode}`;
    case 'exit': return `⏹ processo encerrado${e.error ? `: ${one(e.error, 300)}` : ''}`;
    default: return `· ${e.kind} ${one(JSON.stringify(e))}`;
  }
}

async function watch(sessionId: string): Promise<void> {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
  const rl = flags.answer === 'allow' || flags.answer === 'deny' ? null : createInterface({ input: process.stdin, output: process.stdout });
  let id = sessionId;
  let sawRunning = false;
  const deadline = flags.timeout ? setTimeout(() => (console.log('⏱ timeout'), process.exit(2)), Number(flags.timeout) * 1000) : undefined;

  const done = (code = 0) => {
    clearTimeout(deadline);
    rl?.close();
    ws.close();
    process.exit(code);
  };

  const onEvent = async (e: Ev) => {
    if (e.kind !== 'delta') console.log(`[${e.seq}] ${fmtEvent(e)}`);
    if (e.kind === 'state' && (e.state === 'running' || e.state === 'waiting')) sawRunning = true;
    if (e.kind === 'approval_request') {
      let allow = flags.answer === 'allow';
      if (rl) allow = (await rl.question('   permitir? [s/N] ')).trim().toLowerCase().startsWith('s');
      await api('POST', `/api/sessions/${id}/approvals/${e.requestId}`, { allow });
    }
    if (e.kind === 'question_request') {
      if (flags.answer === 'deny') {
        await api('POST', `/api/sessions/${id}/questions/${e.requestId}`, { decline: true });
        return;
      }
      const answers: Record<string, string> = {};
      for (const q of e.questions as Q[]) {
        console.log(`   [${q.header}] ${q.question}${q.multiSelect ? ' (várias)' : ''}`);
        q.options.forEach((o, i) => console.log(`     ${i + 1}. ${o.label} — ${o.description}`));
        if (!rl) {
          answers[q.question] = (q.options[Number(flags.pick ?? 1) - 1] ?? q.options[0]!).label;
          continue;
        }
        const raw = (await rl.question('   número(s) separados por vírgula, ou texto livre: ')).trim();
        const picks = raw.split(',').map((s) => Number(s.trim()));
        const valid = picks.every((n) => Number.isInteger(n) && n >= 1 && n <= q.options.length);
        answers[q.question] = valid ? picks.map((n) => q.options[n - 1]!.label).join(', ') : raw;
      }
      await api('POST', `/api/sessions/${id}/questions/${e.requestId}`, { answers });
    }
    // O `result` do turno chega logo depois do idle; espera um instante para exibi-lo.
    if (flags.until === 'idle' && e.kind === 'state' && e.state === 'idle' && sawRunning) setTimeout(done, 500);
    if (e.kind === 'exit' && (flags.until === 'idle' || flags.until === 'exit')) done(flags.until === 'exit' ? 0 : 1);
  };

  ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', sessionId, sinceSeq: Number(flags.since ?? 0) })));
  ws.on('message', async (raw) => {
    const m = JSON.parse(String(raw)) as { type: string; [k: string]: unknown };
    if (m.type === 'snapshot') {
      console.log(`— snapshot (estado ${m.state}${m.reset ? ', reset' : ''})`);
      if (m.state === 'running' || m.state === 'waiting') sawRunning = true;
      const events = m.events as Ev[];
      for (const e of events) await onEvent(e);
      // Turno já concluído antes da inscrição: nada a esperar.
      if (flags.until === 'idle' && m.state === 'idle' && events.some((e) => e.kind === 'result')) done();
    } else if (m.type === 'event' && m.sessionId === id) await onEvent(m.event as Ev);
    else if (m.type === 'delta' && m.sessionId === id) process.stdout.write('');
    else if (m.type === 'rekey' && m.from === id) id = String(m.to);
    else if (m.type === 'not_open') {
      console.log('sessão não está aberta no painel (use open/takeover)');
      done(1);
    }
  });
  ws.on('close', () => console.log('— websocket fechado'));
}

switch (command) {
  case 'list': {
    const rows = (await api('GET', '/api/sessions')) as Entry[];
    for (const r of rows.slice(0, Number(args[0] ?? 15))) {
      const when = new Date(r.lastModified).toLocaleString('pt-BR');
      console.log(`${r.sessionId}  ${(r.owner ?? '-').padEnd(5)} ${r.state.padEnd(8)} ${when}  ${r.title.slice(0, 50)}  [${r.cwd ?? ''}]${r.waitingFor ? ` (${r.waitingFor})` : ''}`);
    }
    break;
  }
  case 'projects':
    console.log(((await api('GET', '/api/projects')) as string[]).join('\n'));
    break;
  case 'history': {
    const events = (await api('GET', `/api/sessions/${args[0]}/history?limit=${args[1] ?? 20}`)) as Ev[];
    for (const e of events) console.log(fmtEvent(e));
    break;
  }
  case 'new':
    console.log(await api('POST', '/api/sessions', { cwd: args[0], prompt: args.slice(1).join(' '), ...runOpts() }));
    break;
  case 'open':
    console.log(await api('POST', `/api/sessions/${args[0]}/open`, { fork: flags.fork, ...runOpts() }));
    break;
  case 'takeover':
    console.log(await api('POST', `/api/sessions/${args[0]}/takeover`, runOpts()));
    break;
  case 'release':
    console.log(await api('POST', `/api/sessions/${args[0]}/release`, {}));
    break;
  case 'send':
    console.log(await api('POST', `/api/sessions/${args[0]}/messages`, { text: args.slice(1).join(' ') }));
    break;
  case 'interrupt':
    console.log(await api('POST', `/api/sessions/${args[0]}/interrupt`, {}));
    break;
  case 'approve':
    console.log(await api('POST', `/api/sessions/${args[0]}/approvals/${args[1]}`, { allow: !flags.deny, always: flags.always }));
    break;
  case 'watch':
    await watch(args[0]!);
    break;
  default:
    console.log('comandos: list [n] | projects | history <id> [n] | new <cwd> <prompt> | open <id> [--fork] | takeover <id> | release <id> | send <id> <texto> | interrupt <id> | approve <id> <req> [--deny] [--always] | watch <id> [--since N] [--answer allow|deny|ask] [--until idle|exit] [--timeout s]');
}
