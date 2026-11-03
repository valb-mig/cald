import { createReadStream, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { mkdir } from 'node:fs/promises';
import { activity } from './activity.ts';
import { agentTranscript } from './agents.ts';
import type { Attachment } from './attachments.ts';
import { suggestCommit } from './commit-message.ts';
import { HOST, MACHINE_NAME, PORT, UPLOADS_DIR, WEB_DIST } from './config.ts';
import { HttpError } from './errors.ts';
import { listDir, rawProjectFile, readProjectFile } from './explorer.ts';
import { gitCommit, gitCreateBranch, gitDiff, gitStage, gitStatus, gitSummaries, gitSync, gitUnstage, type DiffSide } from './git.ts';
import { githubAct, githubInfo, githubItem, type GithubAction } from './github.ts';
import { wakatime, wakatimeToday } from './wakatime.ts';
import type { LoggedEvent } from './events.ts';
import { accessGuard, loadAccessPolicy, pinToken, refreshTailnet } from './guard.ts';
import { LiveRegistry } from './live.ts';
import { MachineDirectory } from './machines.ts';
import { Manager } from './manager.ts';
import { MetaStore } from './meta.ts';
import { Notifier } from './notifier.ts';
import { PinLock } from './pin.ts';
import { PushService, type PushPayload, type PushPrefs, type PushSubscriptionInput, type SendOptions } from './push.ts';
import { sessionCost } from './session-cost.ts';
import { AudioMonitor } from './audio.ts';
import { SystemMonitor } from './system.ts';
import { thumbnail } from './thumbs.ts';
import { openTerminal } from './terminal.ts';
import { MAX_TODO_BODY, MAX_TODO_FILES, MAX_TODO_TITLE, MAX_TODOS, TodoStore, type TodoInput } from './todos.ts';
import { MAX_INSTRUCTIONS, MAX_MEMBERS, TeamStore, type TeamInput } from './teams.ts';
import { buildInbox, InboxState, type StateAction } from './inbox.ts';
import { MAX_COMMANDS, MAX_INSTRUCTIONS as MAX_WS_INSTRUCTIONS, MAX_PROJECTS, MAX_RULES, WorkspaceStore, type WorkspaceInput } from './workspaces.ts';
import { MAX_AUDIO_BYTES, transcribe, whisperAvailable } from './transcribe.ts';
import { RESTART_EXIT_CODE, Updater, saveResume, takeResume } from './updater.ts';

await mkdir(UPLOADS_DIR, { recursive: true });
const live = new LiveRegistry();
const meta = new MetaStore();
await meta.load();
const todos = new TodoStore();
await todos.load();
const teams = new TeamStore();
await teams.load();
const inboxState = new InboxState();
await inboxState.load();
const workspaces = new WorkspaceStore();
await workspaces.load();
const manager = new Manager(live, meta, teams, workspaces);
// `TODO:3` numa mensagem leva junto, para o Claude, o conteúdo do item (ver todos.ts).
manager.todoContext = (cwd, text) => todos.context(cwd, text);
const monitor = new SystemMonitor(() => manager.planUsage(), () => manager.planNeedsProbe());
const audio = new AudioMonitor();
monitor.on('error', (err) => app.log.warn({ err }, 'falha ao amostrar o sistema'));
const policy = await loadAccessPolicy();
const pin = new PinLock();
await pin.load();
// Outras máquinas suas com o cald: o app junta as conversas, e os avisos daqui vão para elas.
const machines = new MachineDirectory(policy);
void machines.refresh();
setInterval(() => void machines.list(), 15_000).unref();
const push = new PushService(() => machines.bases());
await push.load();
push.on('error', (err) => app.log.warn({ err }, 'falha ao enviar notificação'));
new Notifier(manager, live, push);

const app = Fastify({ logger: { level: 'info' }, logController: new LogController({ disableRequestLogging: true }) });
await app.register(websocket);
app.addHook('onRequest', accessGuard(policy, pin));

app.setErrorHandler((err: unknown, _req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, ...err.details });
  const e = err as { validation?: unknown; statusCode?: number; message?: string };
  if (e.validation) return reply.code(400).send({ error: 'invalid_request', message: e.message });
  app.log.error(err);
  return reply.code(e.statusCode ?? 500).send({ error: 'internal', message: e.message });
});

// ---- REST: comandos ----

const runOptions = {
  model: { type: 'string' },
  effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
  permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'] },
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

type RunBody = { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' };
type IdParams = { id: string };

const startedAt = Date.now();
app.get('/api/health', async () => ({
  ok: true,
  name: MACHINE_NAME,
  tailnetHost: policy.tailnetHost ?? null,
  startedAt,
  home: homedir(),
}));

/** As outras máquinas suas com o cald, para o app conectar em todas. */
// ---- PIN (ver pin.ts): a tela de bloqueio do app ----

// `unlocked`: o token que veio ainda vale (o app recarregado não precisa pedir o PIN de novo).
app.get('/api/pin', async (req) => ({ ...pin.status(), unlocked: pin.check(pinToken(req)) }));

app.post<{ Body: { pin: string } }>(
  '/api/pin/unlock',
  { schema: { body: { type: 'object', required: ['pin'], properties: { pin: { type: 'string', maxLength: 16 } } } } },
  async (req) => ({ token: await pin.unlock(req.body.pin) }),
);

app.post('/api/pin/lock', async (req) => {
  pin.lock(pinToken(req));
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
  async (req) => agentTranscript(req.params.id, req.params.toolUseId, req.query.agentId),
);

/** Tokens e custo estimado da conversa inteira, subagentes incluídos (ver session-cost.ts). */
app.get<{ Params: IdParams }>('/api/sessions/:id/cost', async (req) => sessionCost(req.params.id));

app.post<{ Body: RunBody & { cwd?: string; prompt: string; title?: string; attachments?: Attachment[]; teamId?: string; workspaceId?: string } }>(
  '/api/sessions',
  {
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    schema: {
      body: {
        type: 'object',
        required: ['prompt'],
        properties: {
          cwd: { type: 'string' },
          prompt: { type: 'string' },
          title: { type: 'string' },
          attachments: attachmentsSchema,
          teamId: { type: 'string', maxLength: 64 },
          workspaceId: { type: 'string', maxLength: 64 },
          ...runOptions,
        },
      },
    },
  },
  async (req) => ({ sessionId: (await manager.create(req.body)).id }),
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

app.post<{ Params: IdParams }>('/api/teams/:id/delete', async (req) => {
  await teams.remove(req.params.id);
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

app.post<{ Params: IdParams; Body: { text: string; attachments?: Attachment[]; clientId?: string } }>(
  '/api/sessions/:id/messages',
  {
    bodyLimit: ATTACHMENT_BODY_LIMIT,
    schema: {
      body: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string' }, attachments: attachmentsSchema, clientId: { type: 'string', maxLength: 64 } },
      },
    },
  },
  async (req) => {
    await manager.send(req.params.id, req.body.text, req.body.attachments, req.body.clientId);
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

app.get('/api/models', async () => manager.models());

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

app.get('/api/update', async () => updater.status());
app.post('/api/update', async () => updater.start());
app.post('/api/update/restart', async () => {
  await updater.restartNow();
  return { ok: true };
});

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

// ---- explorador (só leitura) e git do projeto ----

type ProjectQuery = { Querystring: { cwd: string; path?: string; side?: DiffSide } };
const projectQuery = {
  schema: {
    querystring: {
      type: 'object',
      required: ['cwd'],
      properties: { cwd: { type: 'string' }, path: { type: 'string' }, side: { type: 'string', enum: ['staged', 'unstaged'] } },
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

app.get<ProjectQuery>('/api/file/raw', projectQuery, async (req, reply) => {
  const file = await rawProjectFile(await reviewing(req.query.cwd, req.query.path), req.query.path ?? '');
  return reply
    .header('content-type', file.mediaType)
    .header('cache-control', 'private, no-cache')
    .header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
    .send(createReadStream(file.path));
});

app.get<ProjectQuery>('/api/git', projectQuery, async (req) => gitStatus(await manager.knownCwd(req.query.cwd)));

app.get<ProjectQuery>('/api/git/diff', projectQuery, async (req) => ({
  diff: await gitDiff(await reviewing(req.query.cwd, req.query.path), req.query.path ?? '', req.query.side),
}));

// Controle de código-fonte pelo painel: preparar, tirar do stage, commit e sincronizar. Descartar
// alterações fica de fora de propósito: é a única ação daqui que não teria volta.
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
  async (req) => suggestCommit(await manager.knownCwd(req.body.cwd), req.body.all ?? false),
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
              type: { type: 'string', enum: ['comment', 'labels', 'state', 'assign', 'review', 'merge', 'draft'] },
              body: { type: 'string', maxLength: 65_000 },
              add: { type: 'array', items: { type: 'string' }, maxItems: 50 },
              remove: { type: 'array', items: { type: 'string' }, maxItems: 50 },
              open: { type: 'boolean' },
              reason: { type: 'string', enum: ['completed', 'not planned'] },
              me: { type: 'boolean' },
              event: { type: 'string', enum: ['approve', 'request-changes', 'comment'] },
              method: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
              deleteBranch: { type: 'boolean' },
              draft: { type: 'boolean' },
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
  async (req) => ({ items: todos.list(await manager.knownCwd(req.query.cwd)) }),
);

// A lista inteira de uma vez: o app manda como ficou depois de cada mudança.
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
app.post<{ Body: { cwd: string; items: TodoInput[] } }>(
  '/api/todos',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cwd', 'items'],
        properties: {
          cwd: { type: 'string' },
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
  async (req) => ({ items: await todos.replace(await manager.knownCwd(req.body.cwd), req.body.items) }),
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

app.get<{ Querystring: { cwd: string } }>(
  '/api/commands',
  { schema: { querystring: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' } } } } },
  async (req) => manager.commands(req.query.cwd),
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

app.post<{ Params: IdParams }>('/api/sessions/:id/interrupt', async (req) => {
  await manager.get(req.params.id).interrupt();
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

// ---- WebSocket: catálogo e eventos em tempo real ----

/**
 * O token do PIN de cada WebSocket aberto (o do painel e os de terminal): ao travar o app ou trocar o
 * PIN, quem ficou sem token válido cai na hora. Aberto conta como uso, e o token não expira no meio.
 */
const pinSockets = new Map<WebSocket, string | undefined>();

function holdPin(socket: WebSocket, req: FastifyRequest): void {
  // Guardado mesmo sem PIN: ligar o PIN com o app aberto derruba quem não tem token.
  pinSockets.set(socket, pinToken(req));
  socket.on('close', () => pinSockets.delete(socket));
}

function dropUnlocked(): void {
  for (const [socket, token] of pinSockets) {
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
 * do dono. O que chega antes de a pasta ser conferida (o tamanho da tela) fica guardado e vai depois.
 */
app.get<{ Querystring: { cwd?: string } }>('/ws/terminal', { websocket: true }, (socket, req) => {
  holdPin(socket, req);
  const early: Buffer[] = [];
  const hold = (raw: Buffer) => early.push(raw);
  socket.on('message', hold);
  manager.knownCwd(req.query.cwd ?? '').then(
    (dir) => {
      socket.off('message', hold);
      if (socket.readyState !== socket.OPEN) return;
      openTerminal(socket, dir);
      for (const raw of early) socket.emit('message', raw, false);
    },
    () => socket.close(1008, 'unknown_project'),
  );
});

app.get('/ws', { websocket: true }, (socket, req) => {
  holdPin(socket, req);
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

await live.start();
await app.listen({ host: HOST, port: PORT });
app.log.info({ tailnetHost: policy.tailnetHost, logins: [...policy.logins] }, 'cald pronto');

// No boot o serviço pode subir antes do tailscaled; insiste até conseguir ler o nó.
if (!policy.tailnetHost) {
  app.log.warn('Tailscale indisponível; só acesso local por enquanto');
  const retry = setInterval(async () => {
    if (!(await refreshTailnet(policy))) return;
    clearInterval(retry);
    app.log.info({ tailnetHost: policy.tailnetHost, logins: [...policy.logins] }, 'Tailscale detectado');
  }, 15_000);
}

/**
 * Encerra com calma: sinal do sistema (código 0) ou reinício pedido pela atualização. Guarda as
 * conversas abertas no painel, que voltam sozinhas se o servidor subir de novo em até 10 min.
 */
async function stop(code: number): Promise<void> {
  app.log.info('encerrando sessões do painel…');
  await saveResume(manager.resumable()).catch((err) => app.log.warn({ err }, 'não deu para guardar as conversas abertas'));
  live.stop();
  await manager.shutdown();
  await app.close();
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void stop(0));

// Voltando de um reinício: reabre as conversas que estavam no painel.
const reopened = await manager.reopen(await takeResume());
if (reopened.length) app.log.info({ sessions: reopened }, 'conversas do painel reabertas depois do reinício');
