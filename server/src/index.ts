import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { mkdir } from 'node:fs/promises';
import { AccessMonitor, keyOf, LOCAL } from './access.ts';
import { activity } from './providers/claude/activity.ts';
import type { Attachment } from './attachments.ts';
import { suggestCommit } from './commit-message.ts';
import { CHANNEL, HOST, MACHINE_NAME, PACKAGED, PORT, TEST_BUILD, UPLOADS_DIR, WEB_DIST } from './config.ts';
import { HttpError } from './errors.ts';
import { searchProject } from './search.ts';
import { clearPlugins, HabilidadeStore, MAX_BODY as MAX_HABILIDADE_BODY, MAX_DESCRIPTION as MAX_HABILIDADE_DESCRIPTION, type HabilidadeInput } from './habilidades.ts';
import {
  createProjectEntry,
  listDir,
  projectEntryInfo,
  rawProjectFile,
  readProjectFile,
  restoreProjectEntry,
  saveProjectFile,
  trashProjectEntry,
  watchProjectFile,
} from './explorer.ts';
import {
  gitBase,
  gitBranchChanges,
  gitBranches,
  gitCommit,
  gitCreateBranch,
  gitDeleteBranch,
  gitDiff,
  gitDiscard,
  gitPull,
  gitStage,
  gitStatus,
  gitSummaries,
  gitSwitch,
  gitSync,
  gitUndoDiscard,
  gitUnstage,
  type DiffSide,
} from './git.ts';
import { planPull, type PartialPlan } from './pull-plan.ts';
import { planReview, type PartialReview } from './pull-review-plan.ts';
import { githubAct, githubCreatePull, githubDraft, githubInfo, githubItem, githubPatches, type GithubAction } from './github.ts';
import { wakatime, wakatimeToday } from './wakatime.ts';
import type { LoggedEvent } from './events.ts';
import { accessGuard, loadAccessPolicy, localOnly, pinToken, refreshTailnet } from './guard.ts';
import { RemoteLink } from './link.ts';
import { MachineDirectory } from './machines.ts';
import { Manager } from './manager.ts';
import { MetaStore } from './meta.ts';
import { MessageQueues } from './message-queue.ts';
import { Notifier } from './notifier.ts';
import { PinLock } from './pin.ts';
import { clearProjectIcon, projectIcon, projectIconInfo, setProjectIcon } from './project-icon.ts';
import { openPrototype, PROTOTYPE_CSP, prototypeFile, prototypeVersion, VIEW_ROUTE } from './prototypes.ts';
import { PushService, type PushPayload, type PushPrefs, type PushSubscriptionInput, type SendOptions } from './push.ts';
import { sessionCost } from './providers/claude/cost.ts';
import { AudioMonitor } from './audio.ts';
import { SystemMonitor } from './system.ts';
import { thumbnail } from './thumbs.ts';
import { attachTerminal, openTerminal } from './terminal.ts';
import { ARTEFATO_VIEW_ROUTE, ArtefatoStore, SHELL_CSP, shellHtml, startPublicServer } from './artefatos.ts';
import { editrMcp } from './editr-mcp.ts';
import { ConfigSync, type Appearance, type Direction } from './config-sync.ts';
import { KIND_IDS, type KindId } from './config-sync-kinds.ts';
import { MAX_TODO_BODY, MAX_TODO_FILES, MAX_TODO_TITLE, MAX_TODOS, TodoStore, type TodoInput } from './todos.ts';
import { DetalheStore, MAX_DETALHE_BODY, MAX_DETALHE_TITLE, MAX_DETALHES, type DetalheInput } from './detalhes.ts';
import { MAX_COMMAND, MAX_LABEL, SavedCommandStore, type SavedCommandInput } from './saved-commands.ts';
import { MAX_INSTRUCTIONS, MAX_MEMBERS, TeamStore, type TeamInput } from './teams.ts';
import { buildInbox, InboxState, type StateAction } from './inbox.ts';
import { emptyTrash, listMemory, MAX_MEMORY_DESCRIPTION, MAX_MEMORY_TEXT, restoreMemories, saveMemory, trashMemories } from './providers/claude/memory.ts';
import { MemorySuggestionStore } from './providers/claude/memory-suggestions.ts';
import { claudeItemText } from './providers/claude/setup.ts';
import { emptyClaudeTrash, restoreClaude, setPlugin, setSkill, trashItem, trashMcp, type McpScope } from './providers/claude/manage.ts';
import { ClaudeProvider } from './providers/claude/index.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { MAX_COMMANDS, MAX_INSTRUCTIONS as MAX_WS_INSTRUCTIONS, MAX_PROJECTS, MAX_RULES, WorkspaceStore, type WorkspaceInput } from './workspaces.ts';
import { MAX_AUDIO_BYTES, transcribe, whisperAvailable } from './transcribe.ts';
import { MAX_SPEAK_CHARS, piperAvailable, speak } from './speak.ts';
import { RESTART_EXIT_CODE, Updater, saveResume, takeResume } from './updater.ts';
import { DeviceDirectory, OriginLog } from './origins.ts';

await mkdir(UPLOADS_DIR, { recursive: true });
// Os agentes que conduzem as conversas (ver providers/types.ts). Um agente novo entra nesta lista.
const claude = new ClaudeProvider();
const providers = new ProviderRegistry([claude]);
await providers.load();
const meta = new MetaStore();
await meta.load();
const todos = new TodoStore();
await todos.load();
// Como cada parte de um projeto funciona, para o Claude ler só o que precisa (ver detalhes.ts).
const detalhes = new DetalheStore();
await detalhes.load();
const teams = new TeamStore();
await teams.load();
// O endereço da tailnet vem do `policy`, mais abaixo: só é lido quando o artefato precisa dele.
const artefatos = new ArtefatoStore(() => policy.tailnetHost);
await artefatos.load();
const inboxState = new InboxState();
await inboxState.load();
const workspaces = new WorkspaceStore();
await workspaces.load();
// Os comandos salvos do terminal (ver saved-commands.ts), com as sugestões dos workspaces do projeto.
const savedCommands = new SavedCommandStore(() => workspaces.list());
await savedCommands.load();
// De que aparelho saiu cada mensagem (ver origins.ts).
const origins = new OriginLog();
await origins.load();
const devices = new DeviceDirectory();
// Quem usa o painel agora, quem já passou e quem você desconectou (ver access.ts); o link remoto (ver link.ts).
const access = new AccessMonitor(devices);
await access.load();
const link = new RemoteLink();
// As habilidades do edit.r (ver habilidades.ts); os plugins de conversas de antes de subir saem.
const habilidades = new HabilidadeStore();
await habilidades.load();
// As memórias que o Claude quis guardar e viraram sugestão (ver memory-suggestions.ts).
const memorySuggestions = new MemorySuggestionStore();
await memorySuggestions.load();
await clearPlugins();
// O que você mandou enquanto o Claude trabalhava, esperando a vez (ver message-queue.ts).
const queues = new MessageQueues();
await queues.load();
const manager = new Manager(providers, meta, teams, workspaces, origins, habilidades, queues);
// `TODO:3` numa mensagem leva junto, para o Claude, o conteúdo do item (ver todos.ts).
manager.todoContext = (cwd, text) => todos.context(cwd, text);
manager.suggestMemory = (sessionId, tool, input) => memorySuggestions.propose(sessionId, tool, input);
// O MCP do edit.r em cada conversa do painel (ver editr-mcp.ts): o Claude cria TODOs, times, workspaces e habilidades.
manager.mcpFor = (ctx) => editrMcp({ todos, detalhes, teams, workspaces, habilidades, artefatos, knownCwd: (cwd) => manager.knownCwd(cwd) }, ctx);
// A sua configuração num repositório git seu, para levar a outra máquina (ver config-sync.ts).
const configSync = new ConfigSync({
  teams,
  workspaces,
  habilidades,
  detalhes,
  todos,
  commands: savedCommands,
  providers,
  projects: () => manager.projects(),
  knownCwd: (cwd) => manager.knownCwd(cwd),
});
await configSync.load();
const monitor = new SystemMonitor(() => manager.planUsage(), () => manager.planNeedsProbe());
const audio = new AudioMonitor();
monitor.on('error', (err) => app.log.warn({ err }, 'falha ao amostrar o sistema'));
const policy = await loadAccessPolicy();
const pin = new PinLock();
await pin.load();
// Outras máquinas suas com o edit.r: o app junta as conversas, e os avisos daqui vão para elas.
const machines = new MachineDirectory(policy);
void machines.refresh();
setInterval(() => void machines.list(), 15_000).unref();
// A de teste de uma branch vê as mesmas conversas do PC que a de sempre: repassar dobraria cada aviso.
const push = new PushService(() => (TEST_BUILD ? [] : machines.bases()));
await push.load();
push.on('error', (err) => app.log.warn({ err }, 'falha ao enviar notificação'));
// Aparelho novo ou tentativa barrada: avisa sempre, como as perguntas, e abre na seção Acesso.
access.on('alert', (title: string, body: string) =>
  void push.notify({ title, body, tag: 'access', url: '/?computador=acesso', ts: Date.now() }, { needs: [], urgency: 'high', ttl: 24 * 3600, topic: 'access' }),
);
new Notifier(manager, push);

const app = Fastify({ logger: { level: 'info' }, logController: new LogController({ disableRequestLogging: true }) });
await app.register(websocket);
app.addHook('onRequest', accessGuard(policy, pin, access));

app.setErrorHandler((err: unknown, _req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, ...err.details });
  const e = err as { validation?: unknown; statusCode?: number; message?: string };
  if (e.validation) return reply.code(400).send({ error: 'invalid_request', message: e.message });
  app.log.error(err);
  return reply.code(e.statusCode ?? 500).send({ error: 'internal', message: e.message });
});

// ---- REST: comandos ----

// Os valores são do agente da conversa (ver `features` em providers/types.ts); quem confere é ele.
const runOptions = {
  model: { type: 'string', maxLength: 200 },
  effort: { type: 'string', maxLength: 40 },
  permissionMode: { type: 'string', maxLength: 40 },
} as const;

// Anexos chegam em base64 dentro do JSON: imagens já reduzidas no celular, arquivos até 25 MB.
const ATTACHMENT_BODY_LIMIT = 40 * 1024 * 1024;
const attachmentsSchema = {
  type: 'array',
  maxItems: 10,
  items: {
    type: 'object',
    required: ['name', 'mediaType', 'data'],
    properties: {
      name: { type: 'string', maxLength: 255 },
      mediaType: { type: 'string', maxLength: 255 },
      data: { type: 'string' },
      thumb: { type: 'string', maxLength: 300_000 },
    },
  },
} as const;

type RunBody = { model?: string; effort?: string; permissionMode?: string };
type IdParams = { id: string };

const startedAt = Date.now();
app.get('/api/health', async () => ({
  ok: true,
  name: MACHINE_NAME,
  tailnetHost: policy.tailnetHost ?? null,
  startedAt,
  home: homedir(),
  // O app marca a versão dev (a main, ver updater.ts) na logo, para não confundir com a publicada.
  channel: CHANNEL,
  // E a de teste de uma branch com a faixa da build no topo.
  test: TEST_BUILD,
}));

/** As outras máquinas suas com o edit.r, para o app conectar em todas. */
// ---- PIN (ver pin.ts): a tela de bloqueio do app ----

// `unlocked`: o token que veio ainda vale (o app recarregado não precisa pedir o PIN de novo).
app.get('/api/pin', async (req) => ({ ...pin.status(), unlocked: pin.check(pinToken(req)) }));

app.post<{ Body: { pin: string } }>(
  '/api/pin/unlock',
  { schema: { body: { type: 'object', required: ['pin'], properties: { pin: { type: 'string', maxLength: 16 } } } } },
  async (req) => {
    try {
      return { token: await pin.unlock(req.body.pin) };
    } catch (err) {
      // Na seção Acesso, e com aviso no celular quando passa a fazer esperar.
      if (err instanceof HttpError && (err.code === 'pin_wrong' || err.code === 'pin_blocked')) void access.pinFailed(req, err.code === 'pin_blocked');
      throw err;
    }
  },
);

app.post('/api/pin/lock', async (req) => {
  pin.lock(pinToken(req));
  return { ok: true };
});

// ---- Acesso (ver access.ts e link.ts): ligar o celular, quem está usando e o link remoto ----

app.get('/api/access', async (req) => ({ link: await link.check(), ...access.list(req) }));

/**
 * Liga ou desliga o link remoto. Desligar pela tailnet derruba quem pediu: a resposta sai antes, e o
 * `tailscale serve` desliga logo depois, junto com as janelas abertas por ela.
 */
app.post<{ Body: { on: boolean } }>(
  '/api/access/link',
  { schema: { body: { type: 'object', required: ['on'], properties: { on: { type: 'boolean' } } } } },
  async (req) => {
    if (req.body.on) {
      await link.on();
      await access.linkToggled(req, true);
      return { link: await link.check(true) };
    }
    const off = async () => {
      await link.off();
      await access.linkToggled(req, false);
      for (const [socket, held] of pinSockets) if (held.key !== LOCAL) socket.close(4410, 'link_off');
    };
    if (keyOf(req) === LOCAL) {
      await off();
      return { link: await link.check(true) };
    }
    setTimeout(() => off().catch((err: unknown) => app.log.warn({ err }, 'não deu para desligar o link remoto')), 500);
    return { link: { ...(await link.check()), published: false, shortcut: undefined } };
  },
);

const keyBody = { schema: { body: { type: 'object', required: ['key'], properties: { key: { type: 'string', maxLength: 64 } } } } };

// Desconecta e bloqueia: as janelas abertas dele caem, e o token do PIN dele deixa de valer.
app.post<{ Body: { key: string } }>('/api/access/kick', keyBody, async (req) => {
  access.kick(req.body.key, req);
  for (const [socket, held] of pinSockets) {
    if (held.key !== req.body.key) continue;
    pin.lock(held.token);
    socket.close(4403, 'device_blocked');
  }
  return { ok: true };
});

app.post<{ Body: { key: string } }>('/api/access/unblock', keyBody, async (req) => {
  access.unblock(req.body.key);
  return { ok: true };
});

app.get('/api/machines', async () => ({ name: MACHINE_NAME, machines: await machines.list() }));

app.get('/api/sessions', async () => manager.catalog());

app.get('/api/system', async () => ({ system: monitor.system, usage: monitor.usage }));

// Uso por dia, para a home: grid do ano, gráficos e projetos (ver activity.ts).
// Com `cwd`, só o uso daquele projeto (o hub do projeto).
app.get<{ Querystring: { cwd?: string } }>(
  '/api/activity',
  { schema: { querystring: { type: 'object', properties: { cwd: { type: 'string' } } } } },
  async (req) => activity(req.query.cwd ? await manager.knownCwd(req.query.cwd) : undefined),
);

// A salinha: o que cada claudinho de cada conversa aberta está fazendo (ver office.ts).
app.get('/api/office', async () => manager.office());

app.get('/api/projects', async () => manager.projects());
app.get('/api/projects/sources', async () => manager.projectSources());

// Pasta nova de projeto, na primeira raiz (com `git init`, se pedido).
app.post<{ Body: { name: string; git?: boolean } }>(
  '/api/projects',
  {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, git: { type: 'boolean' } },
      },
    },
  },
  async (req) => manager.createProject(req.body.name, req.body.git ?? false),
);

// Uma pasta que já existe vira projeto (ou deixa de ser, sem apagar nada).
const projectPathBody = {
  schema: { body: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } } } },
};
app.post<{ Body: { path: string } }>('/api/projects/add', projectPathBody, async (req) => manager.addProject(req.body.path));
app.post<{ Body: { path: string } }>('/api/projects/remove', projectPathBody, async (req) => {
  await manager.removeProject(req.body.path);
  return { ok: true };
});

// As subpastas de uma pasta do PC, para escolher a de um projeto (sem `path`, a pasta pessoal).
app.get<{ Querystring: { path?: string } }>(
  '/api/folders',
  { schema: { querystring: { type: 'object', properties: { path: { type: 'string', maxLength: 4096 } } } } },
  async (req) => manager.folders(req.query.path),
);
// Arquivos alterados e commits a enviar/receber de cada projeto; `fetch=1` consulta antes o remoto.
app.get<{ Querystring: { fetch?: string } }>('/api/projects/git', async (req) =>
  gitSummaries(await manager.projects(), req.query.fetch === '1'),
);

app.get<{ Params: IdParams; Querystring: { limit?: number } }>(
  '/api/sessions/:id/history',
  { schema: { querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 2000 } } } } },
  async (req) => manager.history(req.params.id, req.query.limit),
);

/** Ditado pelo Whisper no PC, para navegadores sem reconhecimento de voz, como o Firefox (ver transcribe.ts). */
app.get('/api/transcribe', async () => ({ available: whisperAvailable() }));

app.post<{ Body: { audio: string } }>(
  '/api/transcribe',
  {
    // WAV em base64 dentro do JSON, como os anexos: o guarda só aceita JSON em POST.
    bodyLimit: Math.ceil(MAX_AUDIO_BYTES * 1.4),
    schema: { body: { type: 'object', required: ['audio'], properties: { audio: { type: 'string', minLength: 1 } } } },
  },
  async (req) => {
    const wav = Buffer.from(req.body.audio, 'base64');
    if (wav.length > MAX_AUDIO_BYTES) throw new HttpError(413, 'audio_too_long');
    return { text: await transcribe(wav) };
  },
);

/** Leitura em voz alta pelo Piper no PC, onde a voz do navegador é a do espeak, robótica (ver speak.ts). */
app.get('/api/speak', async () => ({ available: piperAvailable() }));

app.post<{ Body: { text: string } }>(
  '/api/speak',
  { schema: { body: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: MAX_SPEAK_CHARS } } } } },
  async (req, reply) => reply.header('content-type', 'audio/wav').header('cache-control', 'no-store').send(await speak(req.body.text)),
);

/** Tarefa em segundo plano da conversa aberta no painel: o fim da saída e parar (ver tasks.ts). */
app.get<{ Params: IdParams & { taskId: string } }>('/api/sessions/:id/tasks/:taskId/output', async (req) =>
  manager.get(req.params.id).taskOutput(req.params.taskId),
);

app.post<{ Params: IdParams & { taskId: string } }>('/api/sessions/:id/tasks/:taskId/stop', async (req) => {
  await manager.get(req.params.id).stopTask(req.params.taskId);
  return { ok: true };
});

/** O que um subagente da conversa fez, do transcript salvo (ver agents.ts). */
app.get<{ Params: IdParams & { toolUseId: string }; Querystring: { agentId?: string } }>(
  '/api/sessions/:id/agents/:toolUseId',
  { schema: { querystring: { type: 'object', properties: { agentId: { type: 'string', maxLength: 64 } } } } },
  async (req) => manager.subagent(req.params.id, req.params.toolUseId, req.query.agentId),
);

/** Tokens e custo estimado da conversa inteira, subagentes incluídos (ver session-cost.ts). */
app.get<{ Params: IdParams }>('/api/sessions/:id/cost', async (req) => sessionCost(req.params.id));

app.post<{
  Body: RunBody & { provider?: string; cwd?: string; prompt: string; title?: string; attachments?: Attachment[]; teamId?: string; workspaceId?: string; worktree?: boolean };
}>(
  '/api/sessions',
  {
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    schema: {
      body: {
        type: 'object',
        required: ['prompt'],
        properties: {
          // O agente da conversa (GET /api/agents); sem ele, o padrão.
          provider: { type: 'string', maxLength: 40 },
          cwd: { type: 'string' },
          prompt: { type: 'string' },
          title: { type: 'string' },
          attachments: attachmentsSchema,
          teamId: { type: 'string', maxLength: 64 },
          workspaceId: { type: 'string', maxLength: 64 },
          // Abre num worktree novo do projeto, separada das outras conversas dele (ver worktrees.ts).
          worktree: { type: 'boolean' },
          ...runOptions,
        },
      },
    },
  },
  async (req) => ({ sessionId: (await manager.create({ ...req.body, from: await devices.of(req) })).id }),
);

// Times de agentes (ver teams.ts): a conversa nova escolhe um e leva uma cópia dele.
app.get('/api/teams', async () => teams.list());

app.post<{ Body: TeamInput }>(
  '/api/teams',
  {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'members'],
        properties: {
          id: { type: 'string', maxLength: 64 },
          name: { type: 'string', minLength: 1, maxLength: 60 },
          members: {
            type: 'array',
            maxItems: MAX_MEMBERS,
            items: {
              type: 'object',
              required: ['name', 'role', 'instructions'],
              properties: {
                id: { type: 'string', maxLength: 64 },
                name: { type: 'string', minLength: 1, maxLength: 40 },
                role: { type: 'string', maxLength: 60 },
                model: { type: 'string', maxLength: 100 },
                effort: runOptions.effort,
                instructions: { type: 'string', maxLength: MAX_INSTRUCTIONS },
              },
            },
          },
        },
      },
    },
  },
  async (req) => teams.save(req.body),
);

// A inbox (ver inbox.ts): PRs e issues do GitHub da conta, projetos com mudanças e TODOs a fazer;
// `refresh=1` busca de novo no GitHub e consulta o remoto de cada projeto.
app.get<{ Querystring: { refresh?: string } }>('/api/inbox', async (req) =>
  buildInbox(await manager.projects(), todos, req.query.refresh === '1'),
);

// O que você fez com cada item (visto, adiado), guardado no PC principal.
app.get('/api/inbox/state', async () => inboxState.all());

app.post<{ Body: { actions: StateAction[] } }>(
  '/api/inbox/state',
  {
    schema: {
      body: {
        type: 'object',
        required: ['actions'],
        properties: {
          actions: {
            type: 'array',
            maxItems: 200,
            items: {
              type: 'object',
              required: ['key', 'action'],
              properties: {
                key: { type: 'string', minLength: 1, maxLength: 4200 },
                action: { type: 'string', enum: ['seen', 'snooze', 'clear'] },
                mark: { type: 'string', maxLength: 300 },
                until: { type: 'integer', minimum: 0 },
              },
            },
          },
        },
      },
    },
  },
  async (req) => inboxState.apply(req.body.actions),
);

// Workspaces (ver workspaces.ts): moldes de conversa com projetos, contexto, regras, comandos e time padrão.
app.get('/api/workspaces', async () => workspaces.list());

app.post<{ Body: WorkspaceInput }>(
  '/api/workspaces',
  {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'projects', 'instructions', 'rules', 'commands'],
        properties: {
          id: { type: 'string', maxLength: 64 },
          name: { type: 'string', minLength: 1, maxLength: 60 },
          color: { type: 'integer', minimum: 0, maximum: 64 },
          projects: { type: 'array', maxItems: MAX_PROJECTS, items: { type: 'string', maxLength: 4096 } },
          instructions: { type: 'string', maxLength: MAX_WS_INSTRUCTIONS },
          rules: { type: 'array', maxItems: MAX_RULES, items: { type: 'string', maxLength: 1000 } },
          commands: {
            type: 'array',
            maxItems: MAX_COMMANDS,
            items: {
              type: 'object',
              required: ['label', 'command'],
              properties: { label: { type: 'string', maxLength: 60 }, command: { type: 'string', maxLength: 1000 }, cwd: { type: 'string', maxLength: 4096 } },
            },
          },
          teamId: { type: 'string', maxLength: 64 },
        },
      },
    },
  },
  async (req) => {
    // Só projetos que o painel já aceita: uma pasta qualquer não vira cwd de conversa por aqui.
    await Promise.all(req.body.projects.map((p) => manager.knownCwd(p)));
    return workspaces.save(req.body);
  },
);

// O workspace padrão de um projeto (`null` deixa sem): a conversa nova dele já vem com esse.
app.post<{ Body: { cwd: string; workspaceId: string | null } }>(
  '/api/workspaces/default',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'workspaceId'],
        properties: { cwd: { type: 'string', minLength: 1, maxLength: 4096 }, workspaceId: { type: ['string', 'null'], maxLength: 64 } },
      },
    },
  },
  async (req) => workspaces.setDefault(req.body.cwd, req.body.workspaceId),
);

app.post<{ Params: IdParams }>('/api/workspaces/:id/delete', async (req) => {
  await workspaces.remove(req.params.id);
  return { ok: true };
});

app.post<{ Params: IdParams; Body: { name: string; mediaType: string; data: string } }>(
  '/api/workspaces/:id/files',
  {
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    schema: {
      body: {
        type: 'object',
        required: ['name', 'mediaType', 'data'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 300 }, mediaType: { type: 'string' }, data: { type: 'string' } },
      },
    },
  },
  async (req) => workspaces.addFile(req.params.id, req.body),
);

app.post<{ Params: IdParams & { fileId: string } }>('/api/workspaces/:id/files/:fileId/delete', async (req) =>
  workspaces.removeFile(req.params.id, req.params.fileId),
);

app.get<{ Params: IdParams & { fileId: string }; Querystring: { type?: string } }>('/api/workspaces/:id/files/:fileId', async (req, reply) => {
  const path = await workspaces.filePath(req.params.id, req.params.fileId);
  if (!path) throw new HttpError(404, 'workspace_file_not_found');
  const type = req.query.type && /^[\w.+-]+\/[\w.+-]+$/.test(req.query.type) ? req.query.type : 'application/octet-stream';
  return reply
    .header('content-type', type)
    .header('cache-control', 'private, max-age=86400')
    .header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
    .send(createReadStream(path));
});

// Trocar o time de uma conversa que já começou (`null` tira): aberta no painel, ela precisa estar parada.
app.post<{ Params: IdParams; Body: { teamId: string | null } }>(
  '/api/sessions/:id/team',
  { schema: { body: { type: 'object', required: ['teamId'], properties: { teamId: { type: ['string', 'null'], maxLength: 64 } } } } },
  async (req) => {
    await manager.changeTeam(req.params.id, req.body.teamId);
    return { ok: true };
  },
);

// Trocar o workspace de uma conversa que já começou (`null` tira), como o time: o contexto dele entra quando o processo sobe.
app.post<{ Params: IdParams; Body: { workspaceId: string | null } }>(
  '/api/sessions/:id/workspace',
  { schema: { body: { type: 'object', required: ['workspaceId'], properties: { workspaceId: { type: ['string', 'null'], maxLength: 64 } } } } },
  async (req) => {
    await manager.changeWorkspace(req.params.id, req.body.workspaceId);
    return { ok: true };
  },
);

// Apagar manda para a lixeira, de onde volta por 30 dias.
app.post<{ Params: IdParams }>('/api/teams/:id/delete', async (req) => {
  await teams.toTrash(req.params.id);
  return { ok: true };
});
app.get('/api/teams/trash', async () => teams.trashed());
app.post<{ Params: IdParams }>('/api/teams/:id/restore', async (req) => teams.restore(req.params.id));
app.post<{ Params: IdParams }>('/api/teams/:id/purge', async (req) => {
  await teams.purge(req.params.id);
  return { ok: true };
});

app.post<{ Params: IdParams; Body: RunBody & { fork?: boolean; at?: string } }>(
  '/api/sessions/:id/open',
  // `at`: UUID da entrada do log onde cortar, numa bifurcação no meio da conversa.
  { schema: { body: { type: 'object', properties: { fork: { type: 'boolean' }, at: { type: 'string' }, ...runOptions } } } },
  async (req) => ({ sessionId: (await manager.open(req.params.id, req.body)).id }),
);

app.post<{ Params: IdParams; Body: RunBody }>(
  '/api/sessions/:id/takeover',
  { schema: { body: { type: 'object', properties: runOptions } } },
  async (req) => ({ sessionId: (await manager.takeOver(req.params.id, req.body)).id }),
);

app.post<{ Params: IdParams }>('/api/sessions/:id/release', async (req) => manager.release(req.params.id));

// `next`: com o Claude trabalhando, a mensagem entra na fila e vai quando o turno acabar, com o `model` e o
// `effort` dados; a resposta traz o id dela na fila (`queued`). Sem `next`, vai na hora, como sempre.
app.post<{ Params: IdParams; Body: { text: string; attachments?: Attachment[]; clientId?: string; next?: boolean; model?: string; effort?: string } }>(
  '/api/sessions/:id/messages',
  {
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    schema: {
      body: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string' },
          attachments: attachmentsSchema,
          clientId: { type: 'string', maxLength: 64 },
          next: { type: 'boolean' },
          model: runOptions.model,
          effort: runOptions.effort,
        },
      },
    },
  },
  async (req) => {
    const { text, attachments, clientId, next, model, effort } = req.body;
    const { queued } = await manager.send(req.params.id, text, { attachments, clientId, next, model, effort, from: await devices.of(req) });
    return { ok: true, ...(queued ? { queued } : {}) };
  },
);

// A fila de mensagens de uma conversa (ver message-queue.ts). Mandar uma agora, mesmo no meio do turno:
app.post<{ Params: IdParams & { itemId: string } }>('/api/sessions/:id/queue/:itemId/send', async (req) => {
  await manager.sendQueued(req.params.id, req.params.itemId);
  return { ok: true };
});

// Tirar uma da fila, devolvendo-a inteira (com os anexos): para editar na caixa ou para desfazer depois.
app.post<{ Params: IdParams & { itemId: string } }>('/api/sessions/:id/queue/:itemId/take', async (req) =>
  manager.takeQueued(req.params.id, req.params.itemId),
);

// O desfazer de quem tirou uma da fila: ela volta para o lugar `index`.
app.post<{
  Params: IdParams;
  Body: { item: { id: string; text: string; attachments: Attachment[]; model?: string; effort?: string; createdAt: number }; index: number };
}>(
  '/api/sessions/:id/queue',
  {
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    schema: {
      body: {
        type: 'object',
        required: ['item', 'index'],
        properties: {
          index: { type: 'integer', minimum: 0 },
          item: {
            type: 'object',
            required: ['id', 'text', 'attachments', 'createdAt'],
            properties: {
              id: { type: 'string', maxLength: 64 },
              text: { type: 'string' },
              attachments: attachmentsSchema,
              model: runOptions.model,
              effort: runOptions.effort,
              createdAt: { type: 'number' },
            },
          },
        },
      },
    },
  },
  async (req) => {
    manager.restoreQueued(req.params.id, req.body.item, req.body.index);
    return { ok: true };
  },
);

// Abrir uma mensagem da fila na caixa (ela fica segura e volta inteira), ou fechar (`open: null`);
// `save` grava antes a que estava aberta.
app.post<{
  Params: IdParams;
  Body: { open: string | null; save?: { id: string; text: string; attachments: Attachment[]; model?: string; effort?: string } };
}>(
  '/api/sessions/:id/queue/edit',
  {
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    schema: {
      body: {
        type: 'object',
        required: ['open'],
        properties: {
          open: { type: ['string', 'null'], maxLength: 64 },
          save: {
            type: 'object',
            required: ['id', 'text', 'attachments'],
            properties: {
              id: { type: 'string', maxLength: 64 },
              text: { type: 'string' },
              attachments: attachmentsSchema,
              model: runOptions.model,
              effort: runOptions.effort,
            },
          },
        },
      },
    },
  },
  async (req) => ({ message: manager.editQueued(req.params.id, req.body.open, req.body.save) ?? null }),
);

// A nova ordem da fila, pelos ids.
app.post<{ Params: IdParams; Body: { ids: string[] } }>(
  '/api/sessions/:id/queue/order',
  { schema: { body: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 64 } } } } } },
  async (req) => {
    manager.orderQueue(req.params.id, req.body.ids);
    return { ok: true };
  },
);

app.post<{ Params: IdParams; Body: { pinned: boolean } }>(
  '/api/sessions/:id/pin',
  { schema: { body: { type: 'object', required: ['pinned'], properties: { pinned: { type: 'boolean' } } } } },
  async (req) => {
    await manager.setPinned(req.params.id, req.body.pinned);
    return { ok: true };
  },
);

// O nome do claudinho da conversa (o app sorteia um; este é o que você deu). `null` volta ao sorteado.
app.post<{ Params: IdParams; Body: { name: string | null } }>(
  '/api/sessions/:id/claudinho',
  {
    schema: {
      body: { type: 'object', required: ['name'], properties: { name: { type: ['string', 'null'], maxLength: 24 } } },
    },
  },
  async (req) => {
    await manager.setClaudinhoName(req.params.id, req.body.name);
    return { ok: true };
  },
);

app.post<{ Params: IdParams; Body: { title: string } }>(
  '/api/sessions/:id/rename',
  {
    schema: {
      body: { type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 200 } } },
    },
  },
  async (req) => {
    await manager.rename(req.params.id, req.body.title);
    return { ok: true };
  },
);

app.post<{ Params: IdParams; Body: RunBody }>(
  '/api/sessions/:id/settings',
  { schema: { body: { type: 'object', properties: runOptions } } },
  async (req) => {
    await manager.updateSettings(req.params.id, req.body);
    return { ok: true };
  },
);

app.get<{ Params: IdParams }>('/api/sessions/:id/context', async (req) => manager.get(req.params.id).contextUsage());

app.get<{ Querystring: { provider?: string } }>(
  '/api/models',
  { schema: { querystring: { type: 'object', properties: { provider: { type: 'string', maxLength: 40 } } } } },
  async (req) => manager.models(req.query.provider),
);

// ---- agentes (ver providers/): quais estão ligados, o padrão das conversas novas e o que cada um oferece ----

app.get('/api/agents', async () => providers.info());

app.post<{ Params: IdParams; Body: { enabled?: boolean; default?: boolean } }>(
  '/api/agents/:id',
  {
    schema: {
      body: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean' }, default: { type: 'boolean' } } },
    },
  },
  async (req) => {
    await providers.set(req.params.id, req.body);
    return providers.info();
  },
);

// ---- a configuração num repositório (ver config-sync.ts): ligar, enviar, trazer e a prévia (`dry`) ----

app.get('/api/config-sync', async () => configSync.status());

app.post<{ Body: { repo: string; create?: boolean } }>(
  '/api/config-sync/connect',
  {
    schema: {
      body: {
        type: 'object',
        required: ['repo'],
        additionalProperties: false,
        properties: { repo: { type: 'string', minLength: 1, maxLength: 300 }, create: { type: 'boolean' } },
      },
    },
  },
  async (req) => configSync.connect(req.body.repo, req.body.create === true),
);

app.post('/api/config-sync/disconnect', async () => configSync.disconnect());

app.post<{ Body: { direction: Direction; kinds: KindId[]; appearance?: Appearance; dry?: boolean } }>(
  '/api/config-sync/run',
  {
    schema: {
      body: {
        type: 'object',
        required: ['direction', 'kinds'],
        additionalProperties: false,
        properties: {
          direction: { type: 'string', enum: ['push', 'pull'] },
          kinds: { type: 'array', minItems: 1, maxItems: KIND_IDS.length, uniqueItems: true, items: { type: 'string', enum: [...KIND_IDS] } },
          // As preferências do app (chave do localStorage → valor): poucas e pequenas.
          appearance: { type: 'object', maxProperties: 40, additionalProperties: { type: 'string', maxLength: 16_000 } },
          dry: { type: 'boolean' },
        },
      },
    },
  },
  async (req) => configSync.run(req.body.direction, req.body.kinds, req.body.appearance, req.body.dry === true),
);

// ---- atualizar o PC pelo celular (ver updater.ts) ----

const updater = new Updater(
  async () =>
    (await manager.catalog())
      .filter((e) => e.owner === 'panel' && (e.state === 'running' || e.state === 'waiting'))
      .map((e) => e.title),
  async () => {
    // Responde antes de sair, para o celular saber que o reinício começou.
    setTimeout(() => void stop(RESTART_EXIT_CODE), 300);
  },
);

// Empacotado no app do PC não há repositório para puxar, e no teste de uma branch o worktree é dela:
// sem as rotas, o app esconde o cartão.
if (!PACKAGED && !TEST_BUILD) {
  app.get('/api/update', async () => updater.status());
  app.post('/api/update', async () => updater.start());
  app.post('/api/update/restart', async () => {
    await updater.restartNow();
    return { ok: true };
  });
  // No canal dev, daqui em diante se atualiza sozinho a cada merge na main.
  void updater.boot();
}

app.get<{ Params: IdParams & { key: string }; Querystring: { thumb?: string } }>(
  '/api/sessions/:id/images/:key',
  async (req, reply) => {
    const image = await manager.image(req.params.id, req.params.key);
    // `?thumb=1`: versão reduzida para miniaturas; o original fica para a imagem ampliada.
    const { mediaType, data } = req.query.thumb
      ? await thumbnail(`${req.params.id}/${req.params.key}`, image)
      : { mediaType: image.mediaType, data: Buffer.from(image.data, 'base64') };
    return reply.header('content-type', mediaType).header('cache-control', 'private, max-age=86400').send(data);
  },
);

app.post<{ Params: IdParams }>('/api/sessions/:id/delete', async (req) => {
  await manager.delete(req.params.id);
  return { ok: true };
});

// ---- explorador e git do projeto ----

type ProjectQuery = { Querystring: { cwd: string; path?: string; side?: DiffSide } };
const projectQuery = {
  schema: {
    querystring: {
      type: 'object',
      required: ['cwd'],
      properties: { cwd: { type: 'string' }, path: { type: 'string' }, side: { type: 'string', enum: ['staged', 'unstaged', 'head', 'base'] } },
    },
  },
};

app.get<ProjectQuery>('/api/tree', projectQuery, async (req) =>
  listDir(await manager.knownCwd(req.query.cwd), req.query.path ?? ''),
);

// Ler um arquivo ou um diff pelo painel é tempo seu no projeto: conta no WakaTime (ver wakatime.ts).
const reviewing = async (cwd: string, path?: string) => {
  const dir = await manager.knownCwd(cwd);
  void wakatime({ cwd: dir, file: path ? join(dir, path) : undefined, category: 'code reviewing' });
  return dir;
};

app.get<ProjectQuery>('/api/file', projectQuery, async (req) =>
  readProjectFile(await reviewing(req.query.cwd, req.query.path), req.query.path ?? ''),
);

// Buscar texto nos arquivos do projeto (ver search.ts): `regex`, `case` e `word` valem "1" para ligar.
app.get<{ Querystring: { cwd: string; q: string; regex?: string; case?: string; word?: string } }>(
  '/api/search',
  {
    schema: {
      querystring: {
        type: 'object',
        required: ['cwd', 'q'],
        properties: {
          cwd: { type: 'string' },
          q: { type: 'string', minLength: 1, maxLength: 1000 },
          regex: { type: 'string' },
          case: { type: 'string' },
          word: { type: 'string' },
        },
      },
    },
  },
  async (req) =>
    searchProject(await manager.knownCwd(req.query.cwd), req.query.q, {
      regex: req.query.regex === '1',
      caseSensitive: req.query.case === '1',
      word: req.query.word === '1',
    }),
);

// O editor do PC: grava o texto se o arquivo ainda é o que o app leu (`base`, ver saveProjectFile).
// Até o dobro do maior arquivo que abre para edição, pelo JSON e pelos caracteres acentuados.
app.post<{ Body: { cwd: string; path: string; content: string; base: string; force?: boolean } }>(
  '/api/file/save',
  {
    bodyLimit: 2 * 1024 * 1024 + 4096,
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'path', 'content', 'base'],
        properties: {
          cwd: { type: 'string' },
          path: { type: 'string', minLength: 1 },
          content: { type: 'string' },
          base: { type: 'string', maxLength: 64 },
          force: { type: 'boolean' },
        },
      },
    },
  },
  async (req) => {
    const dir = await manager.knownCwd(req.body.cwd);
    const saved = await saveProjectFile(dir, req.body.path, req.body.content, req.body.base, req.body.force ?? false);
    void wakatime({ cwd: dir, file: join(dir, req.body.path), category: 'coding', write: true });
    return saved;
  },
);

// Novo arquivo (vazio) ou pasta pelo explorador; com subpastas no caminho, cria as que faltam. Nunca por cima.
app.post<{ Body: { cwd: string; path: string; type: 'dir' | 'file' } }>(
  '/api/file/create',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'path', 'type'],
        properties: { cwd: { type: 'string' }, path: { type: 'string', minLength: 1, maxLength: 4096 }, type: { type: 'string', enum: ['dir', 'file'] } },
      },
    },
  },
  async (req) => createProjectEntry(await manager.knownCwd(req.body.cwd), req.body.path, req.body.type),
);

// O que apagar levaria, para a confirmação: arquivo ou pasta, e quantos itens ela tem.
app.get<ProjectQuery>('/api/file/info', projectQuery, async (req) =>
  projectEntryInfo(await manager.knownCwd(req.query.cwd), req.query.path ?? ''),
);

// Apagar manda para a lixeira do edit.r (ver trashProjectEntry): o `id` devolvido desfaz, pelo /restore.
app.post<{ Body: { cwd: string; path: string } }>(
  '/api/file/trash',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'path'],
        properties: { cwd: { type: 'string' }, path: { type: 'string', minLength: 1, maxLength: 4096 } },
      },
    },
  },
  async (req) => trashProjectEntry(await manager.knownCwd(req.body.cwd), req.body.path),
);

app.post<{ Body: { cwd: string; id: string } }>(
  '/api/file/restore',
  { schema: { body: { type: 'object', required: ['cwd', 'id'], properties: { cwd: { type: 'string' }, id: { type: 'string', maxLength: 64 } } } } },
  async (req) => restoreProjectEntry(await manager.knownCwd(req.body.cwd), req.body.id),
);

app.get<ProjectQuery>('/api/file/raw', projectQuery, async (req, reply) => {
  const file = await rawProjectFile(await reviewing(req.query.cwd, req.query.path), req.query.path ?? '');
  return reply
    .header('content-type', file.mediaType)
    .header('cache-control', 'private, no-cache')
    .header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
    .send(createReadStream(file.path));
});

// ---- protótipos do Claude (o HTML que a ferramenta Artifact publica; ver prototypes.ts) ----

app.post<{ Body: { path: string; cwd?: string } }>(
  '/api/prototype/open',
  {
    schema: {
      body: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string', minLength: 1, maxLength: 4096 }, cwd: { type: 'string', maxLength: 4096 } },
      },
    },
  },
  async (req) => openPrototype(req.body.path, req.body.cwd),
);

app.get<{ Params: IdParams }>('/api/prototype/:id', async (req) => prototypeVersion(req.params.id));

// Sem o PIN (ver PIN_FREE em guard.ts): o id é a credencial, e a URL do iframe não leva o token.
app.get<{ Params: IdParams & { '*': string } }>(VIEW_ROUTE, async (req, reply) => {
  const file = await prototypeFile(req.params.id, req.params['*']);
  return reply
    .header('content-type', file.mediaType)
    .header('cache-control', 'no-cache')
    .header('content-security-policy', PROTOTYPE_CSP)
    .header('x-content-type-options', 'nosniff')
    // O id vai no caminho: as fontes e scripts de CDN que a página carrega não o recebem.
    .header('referrer-policy', 'no-referrer')
    .send(createReadStream(file.path));
});

// ---- artefatos (as páginas que o Claude publica pelo MCP do edit.r; ver artefatos.ts) ----

app.get('/api/artefatos', async () => ({ artefatos: artefatos.list(), lixeira: artefatos.trashed() }));
app.get<{ Params: IdParams }>('/api/artefatos/:id', async (req) => artefatos.get(req.params.id));
app.post<{ Params: IdParams; Body: { on: boolean } }>(
  '/api/artefatos/:id/public',
  { schema: { body: { type: 'object', required: ['on'], properties: { on: { type: 'boolean' } } } } },
  async (req) => artefatos.setPublic(req.params.id, req.body.on),
);
app.post<{ Params: IdParams }>('/api/artefatos/:id/delete', async (req) => {
  await artefatos.toTrash(req.params.id);
  return { ok: true };
});
app.post<{ Params: IdParams }>('/api/artefatos/:id/restore', async (req) => artefatos.restore(req.params.id));
app.post<{ Params: IdParams }>('/api/artefatos/:id/purge', async (req) => {
  await artefatos.purge(req.params.id);
  return { ok: true };
});

// Sem o PIN (ver PIN_FREE em guard.ts): o id é a credencial. A versão nunca muda: guardada de vez.
app.get<{ Params: IdParams & { n: string; '*': string } }>(ARTEFATO_VIEW_ROUTE, async (req, reply) => {
  const file = await artefatos.file(req.params.id, Number(req.params.n), req.params['*']);
  return reply
    .header('content-type', file.mediaType)
    .header('cache-control', 'private, max-age=31536000, immutable')
    .header('content-security-policy', PROTOTYPE_CSP)
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .send(createReadStream(file.path));
});

/** O link fixo na tailnet: a casca no jeito do edit.r, com a versão `n` (sem ela, a mais nova). */
function artefatoShell(reply: FastifyReply, id: string, n?: number) {
  const a = artefatos.get(id);
  const v = n === undefined ? a.versions.at(-1)! : a.versions.find((x) => x.n === n);
  if (!v) throw new HttpError(404, 'not_found');
  const frame = `/api/artefato/view/${a.id}/${v.n}/${encodeURI(v.entry)}`;
  const versions = a.versions.map((x) => ({ n: x.n, at: x.at, label: x.label, href: `/a/${a.id}/v/${x.n}/` }));
  return reply
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-cache')
    .header('content-security-policy', SHELL_CSP)
    .header('referrer-policy', 'no-referrer')
    .send(shellHtml(a, v.n, frame, versions));
}
app.get<{ Params: IdParams }>('/a/:id', async (req, reply) => reply.redirect(`/a/${req.params.id}/`, 301));
app.get<{ Params: IdParams }>('/a/:id/', async (req, reply) => artefatoShell(reply, req.params.id));
app.get<{ Params: IdParams & { n: string } }>('/a/:id/v/:n/', async (req, reply) => artefatoShell(reply, req.params.id, Number(req.params.n)));

app.get<ProjectQuery>('/api/git', projectQuery, async (req) => gitStatus(await manager.knownCwd(req.query.cwd)));

// A marca do projeto (a escolhida no app ou a logo do próprio repositório). Com ETag e sem cache fixo:
// trocar a logo num aparelho aparece nos outros na próxima vez que desenham. Sem uma, 404, guardado por
// um tempo, para o app não perguntar de novo a cada vez.
app.get<ProjectQuery>('/api/project-icon', projectQuery, async (req, reply) => {
  const icon = await projectIcon(await manager.knownCwd(req.query.cwd));
  if (!icon) return reply.code(404).header('cache-control', 'private, max-age=300').send({ error: 'no_icon' });
  const etag = `"${createHash('sha1').update(icon.data).digest('hex').slice(0, 16)}"`;
  reply.header('etag', etag).header('cache-control', 'private, no-cache');
  if (req.headers['if-none-match'] === etag) return reply.code(304).send();
  return reply.header('content-type', icon.mediaType).send(icon.data);
});
app.get<ProjectQuery>('/api/project-icon/info', projectQuery, async (req) => projectIconInfo(await manager.knownCwd(req.query.cwd)));
// Escolher uma logo para o projeto no app (em base64, como os anexos), ou tirar a escolhida.
app.post<{ Body: { cwd: string; data: string } }>(
  '/api/project-icon',
  {
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    schema: { body: { type: 'object', required: ['cwd', 'data'], properties: { cwd: { type: 'string' }, data: { type: 'string', minLength: 1 } } } },
  },
  async (req) => {
    await setProjectIcon(await manager.knownCwd(req.body.cwd), Buffer.from(req.body.data, 'base64'));
    return { ok: true };
  },
);
app.post<{ Body: { cwd: string } }>(
  '/api/project-icon/remove',
  { schema: { body: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' } } } } },
  async (req) => {
    await clearProjectIcon(await manager.knownCwd(req.body.cwd));
    return { ok: true };
  },
);

// O arquivo no último commit, para o editor marcar o que mudou enquanto se digita (ver gitBase).
app.get<ProjectQuery>('/api/git/base', projectQuery, async (req) => ({
  content: await gitBase(await manager.knownCwd(req.query.cwd), req.query.path ?? ''),
}));

app.get<ProjectQuery>('/api/git/diff', projectQuery, async (req) => ({
  diff: await gitDiff(await reviewing(req.query.cwd, req.query.path), req.query.path ?? '', req.query.side),
}));

// Controle de código-fonte pelo painel: preparar, tirar do stage, descartar (com volta), commit e sincronizar.
type GitPathsBody = { Body: { cwd: string; paths: string[] } };
const gitPathsBody = {
  schema: {
    body: {
      type: 'object',
      required: ['cwd', 'paths'],
      properties: { cwd: { type: 'string' }, paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5000 } },
    },
  },
};

app.post<GitPathsBody>('/api/git/stage', gitPathsBody, async (req) => {
  await gitStage(await manager.knownCwd(req.body.cwd), req.body.paths);
  return { ok: true };
});

app.post<GitPathsBody>('/api/git/unstage', gitPathsBody, async (req) => {
  await gitUnstage(await manager.knownCwd(req.body.cwd), req.body.paths);
  return { ok: true };
});

// Descartar guarda antes como cada arquivo estava: o `undo` devolvido desfaz, por uma hora (ver gitDiscard).
app.post<GitPathsBody>('/api/git/discard', gitPathsBody, async (req) => gitDiscard(await manager.knownCwd(req.body.cwd), req.body.paths));

app.post<{ Body: { cwd: string; undo: string } }>(
  '/api/git/discard/undo',
  { schema: { body: { type: 'object', required: ['cwd', 'undo'], properties: { cwd: { type: 'string' }, undo: { type: 'string', maxLength: 64 } } } } },
  async (req) => {
    await gitUndoDiscard(await manager.knownCwd(req.body.cwd), req.body.undo);
    return { ok: true };
  },
);

app.post<{ Body: { cwd: string; message: string; all?: boolean } }>(
  '/api/git/commit',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'message'],
        properties: { cwd: { type: 'string' }, message: { type: 'string', maxLength: 20_000 }, all: { type: 'boolean' } },
      },
    },
  },
  async (req) => gitCommit(await manager.knownCwd(req.body.cwd), req.body.message, req.body.all ?? false),
);

app.post<{ Body: { cwd: string } }>(
  '/api/git/sync',
  { schema: { body: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' } } } } },
  async (req) => {
    await gitSync(await manager.knownCwd(req.body.cwd));
    return { ok: true };
  },
);

// A mensagem do commit pelo Claude, no jeito dos últimos commits (ver commit-message.ts).
app.post<{ Body: { cwd: string; all?: boolean } }>(
  '/api/git/suggest',
  { schema: { body: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' }, all: { type: 'boolean' } } } } },
  async (req) => suggestCommit(manager.completer(), await manager.knownCwd(req.body.cwd), req.body.all ?? false),
);

app.post<{ Body: { cwd: string; name: string } }>(
  '/api/git/branch',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'name'],
        properties: { cwd: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 200 } },
      },
    },
  },
  async (req) => {
    await gitCreateBranch(await manager.knownCwd(req.body.cwd), req.body.name);
    return { ok: true };
  },
);

// O que a branch mudou desde que saiu da principal, para a lista "Desta branch" do painel.
app.get<ProjectQuery>('/api/git/changes', projectQuery, async (req) => gitBranchChanges(await manager.knownCwd(req.query.cwd)));

// As branches para trocar, com quantos commits cada uma tem fora da principal; `fetch=1` consulta o remoto antes.
app.get<{ Querystring: { cwd: string; fetch?: string } }>(
  '/api/git/branches',
  { schema: { querystring: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' }, fetch: { type: 'string' } } } } },
  async (req) => gitBranches(await manager.knownCwd(req.query.cwd), req.query.fetch === '1'),
);

app.post<{ Body: { cwd: string; branch: string } }>(
  '/api/git/switch',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'branch'],
        properties: { cwd: { type: 'string' }, branch: { type: 'string', minLength: 1, maxLength: 200 } },
      },
    },
  },
  async (req) => {
    await gitSwitch(await manager.knownCwd(req.body.cwd), req.body.branch);
    return { ok: true };
  },
);

// Apagar uma branch: a daqui, a do remoto ou as duas (a tela pede a confirmação antes).
app.post<{ Body: { cwd: string; branch: string; local: boolean; remote: boolean } }>(
  '/api/git/branch/delete',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'branch', 'local', 'remote'],
        properties: { cwd: { type: 'string' }, branch: { type: 'string', minLength: 1, maxLength: 200 }, local: { type: 'boolean' }, remote: { type: 'boolean' } },
      },
    },
  },
  async (req) => {
    await gitDeleteBranch(await manager.knownCwd(req.body.cwd), req.body.branch, req.body.local, req.body.remote);
    return { ok: true };
  },
);

app.post<{ Body: { cwd: string } }>(
  '/api/git/pull',
  { schema: { body: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' } } } } },
  async (req) => gitPull(await manager.knownCwd(req.body.cwd)),
);

// ---- Worktrees das conversas (ver worktrees.ts) ----

// Branch, origem, commits à frente e mudanças sem commit, para a barra do worktree no chat.
app.get<ProjectQuery>('/api/worktree', projectQuery, async (req) => manager.worktreeStatus(req.query.cwd));

const worktreeBody = { schema: { body: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' }, force: { type: 'boolean' } } } } };

// "Trazer": merge da branch do worktree na de origem, no checkout principal.
app.post<{ Body: { cwd: string } }>('/api/worktree/merge', worktreeBody, async (req) => manager.mergeWorktree(req.body.cwd));

// Remove o worktree (e a branch, se foi o edit.r que criou); `force` aceita perder o que não voltou.
app.post<{ Body: { cwd: string; force?: boolean } }>('/api/worktree/remove', worktreeBody, async (req) => {
  await manager.removeWorktree(req.body.cwd, req.body.force ?? false);
  return { ok: true };
});

// Os worktrees de todos os projetos, por repositório, para a seção Worktrees do Computador.
app.get('/api/worktrees', async () => manager.allWorktrees());

const listedBody = {
  schema: {
    body: { type: 'object', required: ['cwd', 'path'], properties: { cwd: { type: 'string' }, path: { type: 'string' }, force: { type: 'boolean' } } },
  },
};

app.post<{ Body: { cwd: string; path: string; force?: boolean } }>('/api/worktrees/remove', listedBody, async (req) => {
  await manager.removeListedWorktree(req.body.cwd, req.body.path, req.body.force ?? false);
  return { ok: true };
});

app.post<{ Body: { cwd: string; path: string } }>('/api/worktrees/merge', listedBody, async (req) => manager.mergeListedWorktree(req.body.cwd, req.body.path));

// ---- GitHub e TODO do projeto (abas da barra do projeto) ----

// PRs e issues abertos, pelo `gh` deste PC, com cache para não gastar a cota da API (ver github.ts).
app.get<{ Querystring: { cwd: string; refresh?: string } }>(
  '/api/github',
  {
    schema: {
      querystring: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' }, refresh: { type: 'string' } } },
    },
  },
  async (req) => githubInfo(await manager.knownCwd(req.query.cwd), req.query.refresh === '1'),
);

// Uma issue ou um PR inteiro, para a aba de análise no meio da tela (mesmo cache).
app.get<{ Querystring: { cwd: string; kind: 'issue' | 'pr'; number: number; refresh?: string } }>(
  '/api/github/item',
  {
    schema: {
      querystring: {
        type: 'object',
        required: ['cwd', 'kind', 'number'],
        properties: {
          cwd: { type: 'string' },
          kind: { type: 'string', enum: ['issue', 'pr'] },
          number: { type: 'integer', minimum: 1 },
          refresh: { type: 'string' },
        },
      },
    },
  },
  async (req) => githubItem(await manager.knownCwd(req.query.cwd), req.query.kind, req.query.number, req.query.refresh === '1'),
);

// Os arquivos de um PR ou de um commit, com o diff de cada um (ver githubPatches).
app.get<{ Querystring: { cwd: string; pr?: number; sha?: string } }>(
  '/api/github/patches',
  {
    schema: {
      querystring: {
        type: 'object',
        required: ['cwd'],
        properties: { cwd: { type: 'string' }, pr: { type: 'integer', minimum: 1 }, sha: { type: 'string', maxLength: 40 } },
      },
    },
  },
  async (req) => {
    const cwd = await manager.knownCwd(req.query.cwd);
    if (req.query.pr) return githubPatches(cwd, { pr: req.query.pr });
    if (req.query.sha) return githubPatches(cwd, { sha: req.query.sha });
    throw new HttpError(400, 'invalid_target');
  },
);

// Abrir um PR pelo edit.r: o que a tela precisa (etiquetas, principal, o que a branch tem) e o "Abrir PR".
app.get<ProjectQuery>('/api/github/draft', projectQuery, async (req) => githubDraft(await manager.knownCwd(req.query.cwd)));

app.post<{ Body: { cwd: string; title: string; body: string; base: string; branch?: string; commits: { message: string; files: string[] }[]; labels: string[]; draft: boolean } }>(
  '/api/github/pull',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'title', 'body', 'base', 'commits', 'labels', 'draft'],
        properties: {
          cwd: { type: 'string' },
          title: { type: 'string', minLength: 1, maxLength: 300 },
          body: { type: 'string', maxLength: 65_000 },
          base: { type: 'string', minLength: 1, maxLength: 200 },
          branch: { type: 'string', minLength: 1, maxLength: 200 },
          commits: {
            type: 'array',
            maxItems: 100,
            items: {
              type: 'object',
              required: ['message', 'files'],
              properties: { message: { type: 'string', maxLength: 20_000 }, files: { type: 'array', items: { type: 'string' }, maxItems: 5000 } },
            },
          },
          labels: { type: 'array', items: { type: 'string' }, maxItems: 50 },
          draft: { type: 'boolean' },
        },
      },
    },
  },
  async (req) => {
    const { cwd, ...draft } = req.body;
    return githubCreatePull(await manager.knownCwd(cwd), draft);
  },
);

/**
 * A resposta de um agente aos poucos, uma linha JSON por vez: o que ele já escreveu (`partial`), no máximo
 * a cada 80 ms, e no fim o resultado (`plan`) ou o erro. Os cabeçalhos do guard (CORS) vão junto. A tela
 * desistir (o "Parar", ou a aba fechou) para o agente: sem ninguém para receber, não há por que seguir.
 */
async function streamAssist<P>(reply: FastifyReply, failed: string, run: (cancel: AbortSignal, partial: (p: P) => void) => Promise<unknown>): Promise<void> {
  reply.hijack();
  const headers = Object.fromEntries(Object.entries(reply.getHeaders()).filter(([, v]) => v !== undefined)) as Record<string, string | number | string[]>;
  reply.raw.writeHead(200, { ...headers, 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const line = (data: unknown) => reply.raw.write(`${JSON.stringify(data)}\n`);
  const cancel = new AbortController();
  reply.raw.once('close', () => !reply.raw.writableFinished && cancel.abort());
  let latest: P | null = null;
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    if (latest) line({ partial: latest });
  };
  try {
    const plan = await run(cancel.signal, (p) => {
      latest = p;
      timer ??= setTimeout(flush, 80);
    });
    if (timer) clearTimeout(timer);
    line({ plan });
  } catch (err) {
    if (timer) clearTimeout(timer);
    line(err instanceof HttpError ? { error: err.code, ...err.details } : { error: failed });
  } finally {
    reply.raw.end();
  }
}

// O PR organizado por um agente, no seu jeito (as suas skills de commit e PR valem): a tela preenche, você abre.
app.post<{ Body: { cwd: string; agent?: string; model?: string; effort?: string; base: string; title?: string; body?: string; labels?: string[] } }>(
  '/api/github/draft/plan',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'base'],
        properties: {
          cwd: { type: 'string' },
          agent: { type: 'string', maxLength: 40 },
          model: { type: 'string', maxLength: 100 },
          effort: { type: 'string', maxLength: 20 },
          base: { type: 'string', minLength: 1, maxLength: 200 },
          title: { type: 'string', maxLength: 300 },
          body: { type: 'string', maxLength: 65_000 },
          labels: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 200 },
        },
      },
    },
  },
  async (req, reply) => {
    const { cwd, agent, ...draft } = req.body;
    const dir = await manager.knownCwd(cwd);
    const provider = agent ? providers.get(agent) : providers.default();
    await streamAssist<PartialPlan>(reply, 'assist_failed', (cancel, partial) => planPull(provider, dir, draft, cancel, partial));
  },
);

// A revisão de um PR por um agente, no seu jeito (as suas skills de revisão valem): a tela põe os
// comentários na sua revisão pendente, e você edita, apaga e envia.
app.post<{ Body: { cwd: string; number: number; agent?: string; model?: string; effort?: string } }>(
  '/api/github/review/plan',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'number'],
        properties: {
          cwd: { type: 'string' },
          number: { type: 'integer', minimum: 1 },
          agent: { type: 'string', maxLength: 40 },
          model: { type: 'string', maxLength: 100 },
          effort: { type: 'string', maxLength: 20 },
        },
      },
    },
  },
  async (req, reply) => {
    const { cwd, number, agent, ...opts } = req.body;
    const dir = await manager.knownCwd(cwd);
    const provider = agent ? providers.get(agent) : providers.default();
    await streamAssist<PartialReview>(reply, 'review_failed', (cancel, partial) => planReview(provider, dir, number, opts, cancel, partial));
  },
);

// Uma ação numa issue ou num PR (comentar, etiquetas, fechar, revisar, merge…), pelo `gh` deste PC.
// Só no clique de quem usa: nada aqui roda sozinho, e cada uma gasta poucas chamadas da cota.
app.post<{ Body: { cwd: string; kind: 'issue' | 'pr'; number: number; action: GithubAction } }>(
  '/api/github/action',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'kind', 'number', 'action'],
        properties: {
          cwd: { type: 'string' },
          kind: { type: 'string', enum: ['issue', 'pr'] },
          number: { type: 'integer', minimum: 1 },
          action: {
            type: 'object',
            required: ['type'],
            properties: {
              type: {
                type: 'string',
                enum: ['comment', 'labels', 'state', 'assign', 'review', 'merge', 'draft', 'edit', 'line-comment', 'line-comments', 'reply', 'resolve', 'edit-comment', 'delete-comment', 'discard-review', 'viewed'],
              },
              body: { type: 'string', maxLength: 65_000 },
              title: { type: 'string', maxLength: 300 },
              add: { type: 'array', items: { type: 'string' }, maxItems: 50 },
              remove: { type: 'array', items: { type: 'string' }, maxItems: 50 },
              open: { type: 'boolean' },
              reason: { type: 'string', enum: ['completed', 'not planned'] },
              me: { type: 'boolean' },
              event: { type: 'string', enum: ['approve', 'request-changes', 'comment'] },
              method: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
              deleteBranch: { type: 'boolean' },
              draft: { type: 'boolean' },
              // Nas linhas: o arquivo, a linha (e o começo do trecho) e o lado do diff; a conversa ou o comentário.
              path: { type: 'string', minLength: 1, maxLength: 1000 },
              line: { type: 'integer', minimum: 1 },
              startLine: { type: 'integer', minimum: 1 },
              side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
              startSide: { type: 'string', enum: ['LEFT', 'RIGHT'] },
              now: { type: 'boolean' },
              thread: { type: 'string', minLength: 1, maxLength: 200 },
              comment: { type: 'string', minLength: 1, maxLength: 200 },
              resolved: { type: 'boolean' },
              viewed: { type: 'boolean' },
              comments: {
                type: 'array',
                maxItems: 100,
                items: {
                  type: 'object',
                  required: ['path', 'line', 'side', 'body'],
                  properties: {
                    path: { type: 'string', minLength: 1, maxLength: 1000 },
                    line: { type: 'integer', minimum: 1 },
                    startLine: { type: 'integer', minimum: 1 },
                    side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
                    startSide: { type: 'string', enum: ['LEFT', 'RIGHT'] },
                    body: { type: 'string', minLength: 1, maxLength: 65_000 },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  async (req) => githubAct(await manager.knownCwd(req.body.cwd), req.body.kind, req.body.number, req.body.action),
);

app.get<{ Querystring: { cwd: string } }>(
  '/api/todos',
  { schema: { querystring: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' } } } } },
  async (req) => {
    const cwd = await manager.knownCwd(req.query.cwd);
    return { items: todos.list(cwd), rev: todos.rev(cwd) };
  },
);

// A lista inteira de uma vez: o app manda como ficou depois de cada mudança, e o `rev` que leu (o Claude
// pode ter mexido no meio; app antigo não manda, e grava como antes).
const todoFile = {
  type: 'object',
  required: ['id', 'name', 'mediaType', 'size'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: 300 },
    mediaType: { type: 'string', maxLength: 200 },
    size: { type: 'number' },
  },
};
app.post<{ Body: { cwd: string; items: TodoInput[]; rev?: number } }>(
  '/api/todos',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'items'],
        properties: {
          cwd: { type: 'string' },
          rev: { type: 'integer', minimum: 0 },
          items: {
            type: 'array',
            maxItems: MAX_TODOS,
            items: {
              type: 'object',
              required: ['id', 'title', 'body', 'done', 'createdAt'],
              additionalProperties: false,
              properties: {
                id: { type: 'string', minLength: 1, maxLength: 64 },
                n: { type: 'integer', minimum: 0 },
                title: { type: 'string', minLength: 1, maxLength: MAX_TODO_TITLE },
                body: { type: 'string', maxLength: MAX_TODO_BODY },
                done: { type: 'boolean' },
                createdAt: { type: 'number' },
                updatedAt: { type: 'number' },
                files: { type: 'array', maxItems: MAX_TODO_FILES, items: todoFile },
              },
            },
          },
        },
      },
    },
  },
  async (req) => {
    const cwd = await manager.knownCwd(req.body.cwd);
    return { items: await todos.replace(cwd, req.body.items, req.body.rev), rev: todos.rev(cwd) };
  },
);

// Um anexo de um item do TODO (imagem ou documento), em base64 como os do chat; o item leva o que volta.
app.post<{ Body: { cwd: string; name: string; mediaType: string; data: string } }>(
  '/api/todos/files',
  {
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'name', 'mediaType', 'data'],
        properties: { cwd: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 300 }, mediaType: { type: 'string' }, data: { type: 'string' } },
      },
    },
  },
  async (req) => {
    await manager.knownCwd(req.body.cwd);
    return todos.saveFile(req.body);
  },
);

app.get<{ Params: { id: string }; Querystring: { type?: string } }>('/api/todos/files/:id', async (req, reply) => {
  const path = await todos.filePath(req.params.id);
  if (!path) throw new HttpError(404, 'todo_file_not_found');
  // O tipo vem do item (o app manda): o arquivo em si foi gravado só com o nome.
  const type = req.query.type && /^[\w.+-]+\/[\w.+-]+$/.test(req.query.type) ? req.query.type : 'application/octet-stream';
  return reply
    .header('content-type', type)
    .header('cache-control', 'private, max-age=86400')
    .header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
    .send(createReadStream(path));
});

app.get<{ Querystring: { cwd: string } }>(
  '/api/detalhes',
  { schema: { querystring: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' } } } } },
  async (req) => {
    const cwd = await manager.knownCwd(req.query.cwd);
    return { items: detalhes.list(cwd), rev: detalhes.rev(cwd) };
  },
);

// Os detalhes do projeto, a lista inteira de uma vez (como o TODO), com o `rev` que o app leu.
app.post<{ Body: { cwd: string; items: DetalheInput[]; rev?: number } }>(
  '/api/detalhes',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'items'],
        properties: {
          cwd: { type: 'string' },
          rev: { type: 'integer', minimum: 0 },
          items: {
            type: 'array',
            maxItems: MAX_DETALHES,
            items: {
              type: 'object',
              required: ['id', 'title', 'body', 'createdAt'],
              additionalProperties: false,
              properties: {
                id: { type: 'string', minLength: 1, maxLength: 64 },
                chave: { type: 'string', maxLength: 100 },
                title: { type: 'string', minLength: 1, maxLength: MAX_DETALHE_TITLE },
                body: { type: 'string', maxLength: MAX_DETALHE_BODY },
                createdAt: { type: 'number' },
                updatedAt: { type: 'number' },
              },
            },
          },
        },
      },
    },
  },
  async (req) => {
    const cwd = await manager.knownCwd(req.body.cwd);
    return { items: await detalhes.replace(cwd, req.body.items, req.body.rev), rev: detalhes.rev(cwd) };
  },
);

// Quanto você já codou hoje, para o anel na alça do PC; `null` sem o wakatime-cli instalado.
app.get('/api/wakatime', async () => ({ today: await wakatimeToday().catch(() => null) }));

/**
 * "Ainda estou aqui": o app avisa enquanto você mexe nele, e o tempo entra no WakaTime como seu,
 * não do Claude. Sem `cwd` (na lista de conversas, por exemplo) não há projeto, e nada é enviado.
 */
app.post<{ Body: { cwd?: string; path?: string; category?: 'code reviewing' | 'planning' } }>(
  '/api/wakatime',
  {
    schema: {
      body: {
        type: 'object',
        properties: { cwd: { type: 'string' }, path: { type: 'string' }, category: { type: 'string', enum: ['code reviewing', 'planning'] } },
      },
    },
  },
  async (req) => {
    if (!req.body.cwd) return { ok: true };
    const dir = await manager.knownCwd(req.body.cwd);
    await wakatime({ cwd: dir, file: req.body.path ? join(dir, req.body.path) : undefined, category: req.body.category ?? 'planning' });
    return { ok: true };
  },
);

app.get<{ Querystring: { cwd: string; session?: string; provider?: string } }>(
  '/api/commands',
  {
    schema: {
      querystring: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' }, session: { type: 'string' }, provider: { type: 'string' } } },
    },
  },
  async (req) => manager.commands(req.query.cwd, req.query.session, req.query.provider),
);

// ---- Habilidades do edit.r (ver habilidades.ts) ----

// As globais, as do projeto de `cwd` (se veio) e a lixeira delas.
app.get<{ Querystring: { cwd?: string } }>(
  '/api/habilidades',
  { schema: { querystring: { type: 'object', properties: { cwd: { type: 'string' } } } } },
  async (req) => manager.listHabilidades(req.query.cwd),
);

// Cria (sem `id`) ou edita. `project`: a pasta do projeto, ou `null` para global.
app.post<{ Body: HabilidadeInput }>(
  '/api/habilidades',
  {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'description', 'body', 'project'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', maxLength: 64 },
          name: { type: 'string', maxLength: 64 },
          description: { type: 'string', maxLength: MAX_HABILIDADE_DESCRIPTION },
          body: { type: 'string', maxLength: MAX_HABILIDADE_BODY },
          project: { type: ['string', 'null'] },
        },
      },
    },
  },
  async (req) => manager.saveHabilidade(req.body),
);

const habilidadeId = { schema: { body: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } } } };
app.post<{ Body: { id: string } }>('/api/habilidades/trash', habilidadeId, async (req) => {
  await habilidades.toTrash(req.body.id);
  return { ok: true };
});
app.post<{ Body: { id: string } }>('/api/habilidades/restore', habilidadeId, async (req) => habilidades.restore(req.body.id));
app.post<{ Body: { id: string } }>('/api/habilidades/purge', habilidadeId, async (req) => {
  await habilidades.purge(req.body.id);
  return { ok: true };
});

// ---- Comandos salvos do terminal (ver saved-commands.ts) ----

// Os do projeto de `cwd`, os globais, a lixeira e as sugestões da pasta. Uma pasta fora dos projetos
// (o terminal foi para `/etc`) recebe só os globais.
app.get<{ Querystring: { cwd?: string } }>(
  '/api/saved-commands',
  { schema: { querystring: { type: 'object', properties: { cwd: { type: 'string' } } } } },
  async (req) => savedCommands.list(req.query.cwd ? await manager.knownCwd(req.query.cwd).catch(() => undefined) : undefined),
);

// Cria (sem `id`) ou edita. `project`: uma pasta do projeto (vale a raiz dele), ou `null` para global.
app.post<{ Body: SavedCommandInput }>(
  '/api/saved-commands',
  {
    schema: {
      body: {
        type: 'object',
        required: ['label', 'command', 'project', 'pinned'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', maxLength: 64 },
          label: { type: 'string', maxLength: MAX_LABEL },
          command: { type: 'string', minLength: 1, maxLength: MAX_COMMAND },
          project: { type: ['string', 'null'] },
          pinned: { type: 'boolean' },
        },
      },
    },
  },
  async (req) => savedCommands.save({ ...req.body, project: req.body.project ? await manager.knownCwd(req.body.project) : null }),
);

const savedCommandId = { schema: { body: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } } } };
app.post<{ Body: { id: string } }>('/api/saved-commands/trash', savedCommandId, async (req) => {
  await savedCommands.toTrash(req.body.id);
  return { ok: true };
});
app.post<{ Body: { id: string } }>('/api/saved-commands/restore', savedCommandId, async (req) => savedCommands.restore(req.body.id));
app.post<{ Body: { id: string } }>('/api/saved-commands/purge', savedCommandId, async (req) => {
  await savedCommands.purge(req.body.id);
  return { ok: true };
});

// O que está desligado numa conversa, e liga ou desliga uma (vale na hora, nas abertas no painel).
app.get<{ Params: IdParams }>('/api/sessions/:id/habilidades', async (req) => manager.sessionHabilidades(req.params.id));
app.post<{ Params: IdParams; Body: { id: string; on: boolean } }>(
  '/api/sessions/:id/habilidades',
  { schema: { body: { type: 'object', required: ['id', 'on'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 }, on: { type: 'boolean' } } } } },
  async (req) => manager.setSessionHabilidade(req.params.id, req.body.id, req.body.on),
);

// A memória automática do Claude Code (ver memory.ts): de todos os projetos ou, com `cwd`, de um só.
app.get<{ Querystring: { cwd?: string } }>(
  '/api/memory',
  { schema: { querystring: { type: 'object', properties: { cwd: { type: 'string' } } } } },
  async (req) => listMemory(req.query.cwd ? await manager.knownCwd(req.query.cwd) : undefined),
);

const memoryRef = {
  type: 'object',
  required: ['folder', 'file'],
  additionalProperties: false,
  properties: { folder: { type: 'string', maxLength: 255 }, file: { type: 'string', maxLength: 210 } },
};
app.put<{ Body: { folder: string; file: string; description: string; body: string; mtime: number } }>(
  '/api/memory',
  {
    schema: {
      body: {
        type: 'object',
        required: ['folder', 'file', 'description', 'body', 'mtime'],
        additionalProperties: false,
        properties: {
          ...memoryRef.properties,
          description: { type: 'string', maxLength: MAX_MEMORY_DESCRIPTION },
          body: { type: 'string', maxLength: MAX_MEMORY_TEXT },
          mtime: { type: 'number' },
        },
      },
    },
  },
  async (req) => saveMemory(req.body),
);

app.post<{ Body: { items: { folder: string; file: string }[] } }>(
  '/api/memory/trash',
  {
    schema: {
      body: { type: 'object', required: ['items'], properties: { items: { type: 'array', minItems: 1, maxItems: 500, items: memoryRef } } },
    },
  },
  async (req) => ({ ids: await trashMemories(req.body.items) }),
);

const trashIds = { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 64 } };
app.post<{ Body: { ids: string[] } }>(
  '/api/memory/restore',
  { schema: { body: { type: 'object', required: ['ids'], properties: { ids: { ...trashIds, minItems: 1 } } } } },
  async (req) => {
    await restoreMemories(req.body.ids);
    return { ok: true };
  },
);

// Sem `ids`, esvazia a lixeira inteira.
app.post<{ Body: { ids?: string[] } }>(
  '/api/memory/trash/empty',
  { schema: { body: { type: 'object', properties: { ids: trashIds } } } },
  async (req) => {
    await emptyTrash(req.body.ids);
    return { ok: true };
  },
);

// As memórias que o Claude quis guardar nesta conversa e esperam você: salvar (talvez editada), recusar ou desfazer a recusa.
type SuggestionParams = IdParams & { suggestion: string };
app.get<{ Params: IdParams }>('/api/sessions/:id/memory-suggestions', async (req) => memorySuggestions.list(req.params.id));

app.post<{ Params: SuggestionParams; Body: { description?: string; body?: string } }>(
  '/api/sessions/:id/memory-suggestions/:suggestion/save',
  {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', maxLength: MAX_MEMORY_DESCRIPTION },
          body: { type: 'string', minLength: 1, maxLength: MAX_MEMORY_TEXT },
        },
      },
    },
  },
  async (req) => {
    await memorySuggestions.accept(req.params.id, req.params.suggestion, req.body);
    return { ok: true };
  },
);

app.post<{ Params: SuggestionParams }>('/api/sessions/:id/memory-suggestions/:suggestion/dismiss', async (req) => {
  await memorySuggestions.dismiss(req.params.id, req.params.suggestion);
  return { ok: true };
});

app.post<{ Params: SuggestionParams }>('/api/sessions/:id/memory-suggestions/:suggestion/restore', async (req) => {
  await memorySuggestions.restore(req.params.id, req.params.suggestion);
  return { ok: true };
});

// Skills, agentes e servidores MCP de uma pasta (sem `cwd`, os que valem em todas). Pode subir uma sonda.
app.get<{ Querystring: { cwd?: string; refresh?: string } }>(
  '/api/claude/setup',
  { schema: { querystring: { type: 'object', properties: { cwd: { type: 'string' }, refresh: { type: 'string' } } } } },
  async (req) => {
    const cwd = req.query.cwd ? await manager.knownCwd(req.query.cwd) : undefined;
    return claude.setup(cwd ?? homedir(), cwd !== undefined, () => manager.projects(), req.query.refresh === '1');
  },
);

app.get<{ Querystring: { cwd?: string; path: string } }>(
  '/api/claude/text',
  { schema: { querystring: { type: 'object', required: ['path'], properties: { cwd: { type: 'string' }, path: { type: 'string' } } } } },
  async (req) => ({ text: await claudeItemText(req.query.cwd ? await manager.knownCwd(req.query.cwd) : homedir(), req.query.path) }),
);

// Liga e desliga: servidor MCP numa pasta (sem `cwd`, na pessoal), skill (sem `cwd`, em todo projeto) e plugin.
const toggleBody = (required: string[], name: object) => ({
  body: {
    type: 'object',
    required,
    additionalProperties: false,
    properties: { cwd: { type: 'string' }, ...name, enabled: { type: 'boolean' } },
  },
});
const nameField = { name: { type: 'string', minLength: 1, maxLength: 200 } };

app.post<{ Body: { cwd?: string; name: string; enabled: boolean } }>(
  '/api/claude/mcp',
  { schema: toggleBody(['name', 'enabled'], nameField) },
  async (req) => {
    await claude.toggleMcp(req.body.cwd ? await manager.knownCwd(req.body.cwd) : homedir(), req.body.name, req.body.enabled);
    return { ok: true };
  },
);

app.post<{ Body: { cwd?: string; name: string; enabled: boolean } }>(
  '/api/claude/skill',
  { schema: toggleBody(['name', 'enabled'], nameField) },
  async (req) => {
    await setSkill(req.body.cwd ? await manager.knownCwd(req.body.cwd) : undefined, req.body.name, req.body.enabled);
    manager.forgetSetup();
    return { ok: true };
  },
);

app.post<{ Body: { key: string; enabled: boolean } }>(
  '/api/claude/plugin',
  { schema: toggleBody(['key', 'enabled'], { key: { type: 'string', minLength: 1, maxLength: 200 } }) },
  async (req) => {
    await setPlugin(req.body.key, req.body.enabled);
    manager.forgetSetup();
    return { ok: true };
  },
);

// Para a lixeira do edit.r: uma skill, comando ou agente (pelo caminho) ou a configuração de um servidor MCP.
app.post<{ Body: { cwd?: string; path?: string; mcp?: { name: string; scope: McpScope; project?: string } } }>(
  '/api/claude/trash',
  {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cwd: { type: 'string' },
          path: { type: 'string', maxLength: 1000 },
          mcp: {
            type: 'object',
            required: ['name', 'scope'],
            additionalProperties: false,
            properties: { ...nameField, scope: { enum: ['user', 'local', 'project'] }, project: { type: 'string' } },
          },
        },
      },
    },
  },
  async (req) => {
    const { cwd, path, mcp } = req.body;
    let id: string;
    if (mcp) id = await trashMcp(mcp.name, mcp.scope, mcp.project ? await manager.knownCwd(mcp.project) : null);
    else if (path) id = await trashItem(cwd ? await manager.knownCwd(cwd) : homedir(), path);
    else throw new HttpError(400, 'invalid_request');
    manager.forgetSetup();
    return { id };
  },
);

app.post<{ Body: { ids: string[] } }>(
  '/api/claude/restore',
  { schema: { body: { type: 'object', required: ['ids'], properties: { ids: { ...trashIds, minItems: 1 } } } } },
  async (req) => {
    await restoreClaude(req.body.ids);
    manager.forgetSetup();
    return { ok: true };
  },
);

app.post<{ Body: { ids?: string[] } }>(
  '/api/claude/trash/empty',
  { schema: { body: { type: 'object', properties: { ids: trashIds } } } },
  async (req) => {
    await emptyClaudeTrash(req.body.ids);
    return { ok: true };
  },
);

app.get<{ Querystring: { cwd: string; q?: string } }>(
  '/api/files',
  {
    schema: {
      querystring: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' }, q: { type: 'string' } } },
    },
  },
  async (req) => manager.files(req.query.cwd, req.query.q ?? ''),
);

// Parar o turno também pausa a fila (ver Manager.interrupt).
app.post<{ Params: IdParams }>('/api/sessions/:id/interrupt', async (req) => {
  await manager.interrupt(req.params.id);
  return { ok: true };
});

app.post<{ Params: IdParams & { requestId: string }; Body: { allow: boolean; message?: string; always?: boolean } }>(
  '/api/sessions/:id/approvals/:requestId',
  {
    schema: {
      body: {
        type: 'object',
        required: ['allow'],
        properties: { allow: { type: 'boolean' }, message: { type: 'string' }, always: { type: 'boolean' } },
      },
    },
  },
  async (req) => {
    manager.get(req.params.id).answer(req.params.requestId, req.body);
    return { ok: true };
  },
);

app.post<{ Params: IdParams & { requestId: string }; Body: { answers?: Record<string, string>; decline?: boolean } }>(
  '/api/sessions/:id/questions/:requestId',
  {
    schema: {
      body: {
        type: 'object',
        properties: {
          answers: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } },
          decline: { type: 'boolean' },
        },
      },
    },
  },
  async (req) => {
    manager.get(req.params.id).answerQuestion(req.params.requestId, req.body);
    return { ok: true };
  },
);

// ---- notificações (Web Push) ----

const endpointSchema = { type: 'string', pattern: '^https://', maxLength: 2048 } as const;

app.get('/api/push/key', async () => ({ publicKey: push.publicKey }));

app.post<{ Body: { subscription: PushSubscriptionInput; prefs: PushPrefs } }>(
  '/api/push/subscribe',
  {
    schema: {
      body: {
        type: 'object',
        required: ['subscription', 'prefs'],
        properties: {
          subscription: {
            type: 'object',
            required: ['endpoint', 'keys'],
            properties: {
              endpoint: endpointSchema,
              keys: {
                type: 'object',
                required: ['p256dh', 'auth'],
                properties: { p256dh: { type: 'string', maxLength: 256 }, auth: { type: 'string', maxLength: 256 } },
              },
            },
          },
          prefs: {
            type: 'object',
            required: ['done', 'pc'],
            properties: { done: { type: 'boolean' }, pc: { type: 'boolean' } },
          },
        },
      },
    },
  },
  async (req) => {
    const { endpoint, keys } = req.body.subscription;
    await push.subscribe({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }, {
      done: req.body.prefs.done,
      pc: req.body.prefs.pc,
    });
    return { ok: true };
  },
);

const endpointBody = {
  schema: { body: { type: 'object', required: ['endpoint'], properties: { endpoint: endpointSchema } } },
};

app.post<{ Body: { endpoint: string } }>('/api/push/unsubscribe', endpointBody, async (req) => {
  await push.unsubscribe(req.body.endpoint);
  return { ok: true };
});

app.post<{ Body: { endpoint: string } }>('/api/push/test', endpointBody, async (req) => {
  await push.test(req.body.endpoint);
  return { ok: true };
});

// Aviso de outra máquina sua: entrega aos aparelhos inscritos aqui, sem repassar de novo.
app.post<{ Body: { payload: PushPayload; opts: SendOptions } }>(
  '/api/push/relay',
  {
    schema: {
      body: {
        type: 'object',
        required: ['payload', 'opts'],
        properties: {
          payload: {
            type: 'object',
            required: ['title', 'body', 'tag', 'url', 'ts'],
            properties: {
              title: { type: 'string', maxLength: 200 },
              body: { type: 'string', maxLength: 2000 },
              tag: { type: 'string', maxLength: 200 },
              url: { type: 'string', pattern: '^/', maxLength: 500 },
              ts: { type: 'number' },
            },
          },
          opts: {
            type: 'object',
            required: ['needs', 'urgency', 'ttl'],
            properties: {
              needs: { type: 'array', items: { type: 'string', enum: ['done', 'pc'] } },
              urgency: { type: 'string', enum: ['very-low', 'low', 'normal', 'high'] },
              ttl: { type: 'number', minimum: 0, maximum: 2_419_200 },
              topic: { type: 'string', maxLength: 32 },
            },
          },
        },
      },
    },
  },
  async (req) => {
    await push.notifyHere(req.body.payload, req.body.opts);
    return { ok: true };
  },
);

// Os avisos para o app do PC (ver desktop/src/notifications.ts): o Electron não tem Web Push, então
// ele ouve aqui, em Server-Sent Events, e mostra cada um como notificação do sistema. Só pela porta local.
// Abertos enquanto o app do PC está de pé: ao encerrar, o servidor fecha cada um (ver `stop`).
const localStreams = new Set<ServerResponse>();
app.get('/api/push/local', (req, reply) => {
  if (!localOnly(policy, req)) return reply.code(403).send({ error: 'local_only' });
  reply.hijack();
  localStreams.add(reply.raw);
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  reply.raw.write(': edit.r\n\n');
  const send = (payload: PushPayload, opts: SendOptions) => reply.raw.write(`data: ${JSON.stringify({ payload, opts })}\n\n`);
  // Comentário de tempos em tempos: a conexão parada não cai por inatividade.
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 30_000);
  push.on('local', send);
  req.raw.on('close', () => {
    clearInterval(ping);
    push.off('local', send);
    localStreams.delete(reply.raw);
  });
});

// ---- WebSocket: catálogo e eventos em tempo real ----

/**
 * O token do PIN de cada WebSocket aberto (o do painel e os de terminal): ao travar o app ou trocar o
 * PIN, quem ficou sem token válido cai na hora. Aberto conta como uso, e o token não expira no meio.
 */
const pinSockets = new Map<WebSocket, { token: string | undefined; key: string }>();

function holdPin(socket: WebSocket, req: FastifyRequest): void {
  // Guardado mesmo sem PIN: ligar o PIN com o app aberto derruba quem não tem token. O aparelho é para
  // desconectar todas as janelas dele de uma vez, e para fechar as da tailnet ao desligar o link.
  pinSockets.set(socket, { token: pinToken(req), key: keyOf(req) });
  socket.on('close', () => pinSockets.delete(socket));
}

function dropUnlocked(): void {
  for (const [socket, { token }] of pinSockets) {
    if (pin.enabled && !pin.check(token)) socket.close(4401, 'pin_required');
  }
}
pin.on('revoke', dropUnlocked);
setInterval(dropUnlocked, 60_000).unref();

type ClientMsg =
  | { type: 'subscribe'; sessionId: string; sinceSeq?: number; runId?: string }
  | { type: 'unsubscribe'; sessionId: string }
  // Espectro do que sai pelas caixas, para o fundo da conversa (ver audio.ts).
  | { type: 'listen_audio' }
  | { type: 'unlisten_audio' };

/** Quem está com o fundo de som na tela; a captura só roda enquanto este conjunto tem alguém. */
const listening = new Set<WebSocket>();

function listenAudio(socket: WebSocket, on: boolean): void {
  if (on === listening.has(socket)) return;
  if (on) {
    listening.add(socket);
    audio.addClient();
    send(socket, { type: 'audio_ready', available: audio.available });
  } else {
    listening.delete(socket);
    audio.removeClient();
  }
}

const clients = new Map<WebSocket, Set<string>>();

function send(socket: WebSocket, payload: unknown): void {
  sendRaw(socket, JSON.stringify(payload));
}

function sendRaw(socket: WebSocket, data: string): void {
  if (socket.readyState === socket.OPEN) socket.send(data);
}

/** Manda a mesma mensagem a vários: serializada uma vez só, e só se houver alguém para receber. */
function sendEach(sockets: Iterable<WebSocket>, payload: unknown): void {
  let data: string | undefined;
  for (const socket of sockets) sendRaw(socket, (data ??= JSON.stringify(payload)));
}

function subscribe(socket: WebSocket, sessionId: string, sinceSeq: number, runId?: string): void {
  clients.get(socket)?.add(sessionId);
  const session = manager.find(sessionId);
  if (!session) return send(socket, { type: 'not_open', sessionId });
  // Outro processo da mesma conversa: o seq que o cliente conhece não vale mais.
  const sameRun = runId === session.runId;
  const { reset, events } = session.eventsSince(sameRun ? sinceSeq : 0);
  send(socket, {
    type: 'snapshot',
    sessionId,
    runId: session.runId,
    state: session.state,
    waitingFor: session.waitingFor,
    reset: reset || !sameRun,
    events,
  });
}

/**
 * Terminal do painel, na pasta de um projeto conhecido (ver terminal.ts). A proteção de acesso vale
 * aqui como no resto: só a origem do app abre (um site qualquer no navegador, não), e só pela tailnet
 * do dono. Com o id de uma aba cujo shell ainda vive, liga nele e manda o que veio depois de `since`;
 * senão abre um novo. O que chega antes de a pasta ser conferida (o tamanho da tela) fica guardado e vai depois.
 */
app.get<{ Querystring: { cwd?: string; id?: string; since?: string } }>('/ws/terminal', { websocket: true }, (socket, req) => {
  holdPin(socket, req);
  const since = Number(req.query.since ?? 0);
  if (attachTerminal(socket, req.query.id, since)) return;
  const early: Buffer[] = [];
  const hold = (raw: Buffer) => early.push(raw);
  socket.on('message', hold);
  manager.knownCwd(req.query.cwd ?? '').then(
    (dir) => {
      socket.off('message', hold);
      if (socket.readyState !== socket.OPEN) return;
      openTerminal(socket, dir, req.query.id, since);
      for (const raw of early) socket.emit('message', raw, false);
    },
    () => socket.close(1008, 'unknown_project'),
  );
});

/**
 * O arquivo aberto no editor do PC: manda `{ hash }` agora e a cada vez que ele muda no disco (`null` se
 * sumiu), para o editor recarregar o que o Claude gravou. O ping mantém a conexão de pé atrás do proxy.
 */
app.get<{ Querystring: { cwd?: string; path?: string } }>('/ws/file', { websocket: true }, (socket, req) => {
  holdPin(socket, req);
  let stop: (() => void) | null = null;
  const ping = setInterval(() => socket.ping(), 25_000);
  socket.on('close', () => {
    clearInterval(ping);
    stop?.();
  });
  manager
    .knownCwd(req.query.cwd ?? '')
    .then((dir) => watchProjectFile(dir, req.query.path ?? '', (hash) => socket.send(JSON.stringify({ hash }))))
    .then(
      (unwatch) => {
        if (socket.readyState === socket.OPEN) stop = unwatch;
        else unwatch();
      },
      () => socket.close(1008, 'not_found'),
    );
});

app.get('/ws', { websocket: true }, (socket, req) => {
  holdPin(socket, req);
  // Uma janela do app aberta: entra na lista de quem está usando (ver access.ts).
  void access.open(socket, req);
  clients.set(socket, new Set());
  let alive = true;
  socket.on('pong', () => (alive = true));
  const heartbeat = setInterval(() => {
    if (!alive) return socket.terminate();
    alive = false;
    socket.ping();
    // O navegador não enxerga pings de protocolo; o tick deixa o cliente detectar conexão morta.
    send(socket, { type: 'tick' });
  }, 25_000);

  socket.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      return send(socket, { type: 'error', error: 'invalid_json' });
    }
    if (msg.type === 'subscribe') subscribe(socket, msg.sessionId, msg.sinceSeq ?? 0, msg.runId);
    else if (msg.type === 'unsubscribe') clients.get(socket)?.delete(msg.sessionId);
    else if (msg.type === 'listen_audio') listenAudio(socket, true);
    else if (msg.type === 'unlisten_audio') listenAudio(socket, false);
  });
  socket.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(socket);
    listenAudio(socket, false);
    monitor.removeClient();
  });

  send(socket, { type: 'hello', serverTime: Date.now() });
  // Monitor do PC só roda com alguém olhando; o último valor conhecido vai na hora.
  monitor.addClient();
  if (monitor.system) send(socket, { type: 'system', system: monitor.system });
  send(socket, { type: 'usage', usage: monitor.usage });
  void manager.catalog().then((sessions) => send(socket, { type: 'catalog', sessions }));
});

function broadcast(sessionId: string, payload: unknown): void {
  let data: string | undefined;
  for (const [socket, subs] of clients) if (subs.has(sessionId)) sendRaw(socket, (data ??= JSON.stringify(payload)));
}

manager.on('event', (sessionId: string, event: LoggedEvent, runId: string) =>
  broadcast(sessionId, { type: 'event', sessionId, runId, event }),
);
manager.on('delta', (sessionId: string, text: string) => broadcast(sessionId, { type: 'delta', sessionId, text }));
manager.on('rekey', (from: string, to: string) => {
  memorySuggestions.rekey(from, to);
  for (const [socket, subs] of clients) {
    if (subs.delete(from)) {
      subs.add(to);
      send(socket, { type: 'rekey', from, to, look: manager.lookOf(to) });
    }
  }
});

function broadcastAll(payload: unknown): void {
  sendEach(clients.keys(), payload);
}
monitor.on('system', (system) => broadcastAll({ type: 'system', system }));
audio.on('spectrum', (spectrum: unknown) => sendEach(listening, { type: 'audio', spectrum }));
monitor.on('usage', (usage) => broadcastAll({ type: 'usage', usage }));
// Mudou o TODO de um projeto, um time, um workspace ou uma habilidade (pelo app ou pelo Claude, ver
// editr-mcp.ts): cada aparelho recarrega o que tiver aberto disso.
todos.on('change', (cwd: string) => broadcastAll({ type: 'changed', what: 'todos', cwd, rev: todos.rev(cwd) }));
detalhes.on('change', (cwd: string) => broadcastAll({ type: 'changed', what: 'detalhes', cwd, rev: detalhes.rev(cwd) }));
teams.on('change', () => broadcastAll({ type: 'changed', what: 'teams' }));
workspaces.on('change', () => broadcastAll({ type: 'changed', what: 'workspaces' }));
artefatos.on('change', () => broadcastAll({ type: 'changed', what: 'artefatos' }));
habilidades.on('change', () => broadcastAll({ type: 'changed', what: 'habilidades' }));
savedCommands.on('change', () => broadcastAll({ type: 'changed', what: 'saved-commands' }));
access.on('change', () => broadcastAll({ type: 'changed', what: 'access' }));
memorySuggestions.on('change', (session: string) => broadcastAll({ type: 'changed', what: 'memory-suggestions', session }));
providers.on('change', () => broadcastAll({ type: 'changed', what: 'agents' }));

let catalogTimer: NodeJS.Timeout | undefined;
manager.on('catalog', () => {
  clearTimeout(catalogTimer);
  catalogTimer = setTimeout(async () => {
    const sessions = await manager.catalog().catch(() => null);
    if (sessions) broadcastAll({ type: 'catalog', sessions });
  }, 300);
});

// ---- frontend (PWA) na mesma origem da API ----

if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, {
    root: WEB_DIST,
    // Usa o .br/.gz gerado no build (ver web/scripts/compress.mjs) quando o navegador aceita.
    preCompressed: true,
    setHeaders: (res, path) => {
      // Arquivos com hash no nome nunca mudam; o resto precisa revalidar para a PWA atualizar.
      // `path` é o do arquivo enviado, comprimido ou não: a regra vale igual para os dois.
      const immutable = path.includes('/assets/');
      res.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  // Rotas do SPA (/s/:id, /projetos…) caem no index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && req.url !== '/ws') {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found' });
  });
}

// ---- ciclo de vida ----

await Promise.all(providers.enabled().map((p) => p.external?.start()));
await app.listen({ host: HOST, port: PORT });
app.log.info({ tailnetHost: policy.tailnetHost, logins: [...policy.logins] }, 'edit.r pronto');

// O link público dos artefatos: um servidor à parte, que só serve os públicos (ver artefatos.ts).
const publicServer = startPublicServer(artefatos, (msg, err) => app.log.warn({ err }, msg));
artefatos.syncFunnel().catch((err) => app.log.warn({ err }, 'artefatos: não deu para ligar o Funnel'));

// No boot o serviço pode subir antes do tailscaled; insiste até conseguir ler o nó.
if (!policy.tailnetHost) {
  app.log.warn('Tailscale indisponível; só acesso local por enquanto');
  const retry = setInterval(async () => {
    if (!(await refreshTailnet(policy))) return;
    clearInterval(retry);
    app.log.info({ tailnetHost: policy.tailnetHost, logins: [...policy.logins] }, 'Tailscale detectado');
  }, 15_000);
}

// Prazo para encerrar com calma, abaixo dos 20 s que o systemd (`TimeoutStopSec`) e o app do PC esperam.
const STOP_DEADLINE_MS = 15_000;

/**
 * Encerra com calma: sinal do sistema (código 0) ou reinício pedido pela atualização. Guarda as
 * conversas abertas no painel, que voltam sozinhas se o servidor subir de novo em até 10 min.
 */
async function stop(code: number): Promise<void> {
  app.log.info('encerrando sessões do painel…');
  // Preso no meio do encerramento, o servidor já não atende e ainda não saiu: nem o systemd nem o app do
  // PC sobem outro no lugar. Passado o prazo, sai assim mesmo.
  setTimeout(() => {
    app.log.warn('o encerramento passou do prazo; saindo assim mesmo');
    process.exit(code);
  }, STOP_DEADLINE_MS).unref();
  await saveResume(manager.resumable()).catch((err) => app.log.warn({ err }, 'não deu para guardar as conversas abertas'));
  for (const p of providers.all()) p.external?.stop();
  publicServer.close();
  // Os avisos do app do PC não terminam sozinhos, e o `app.close()` espera cada conexão aberta.
  for (const res of localStreams) res.end();
  await manager.shutdown();
  await app.close();
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void stop(0));

// Voltando de um reinício: reabre as conversas que estavam no painel.
const reopened = await manager.reopen(await takeResume());
if (reopened.length) app.log.info({ sessions: reopened }, 'conversas do painel reabertas depois do reinício');
