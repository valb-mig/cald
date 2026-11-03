import { EventEmitter } from 'node:events';
import { readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  getSessionInfo,
  deleteSession,
  getSessionMessages,
  listSessions,
  renameSession,
  type EffortLevel,
  type PermissionMode,
  type SDKSessionInfo,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { PROJECT_ROOTS, UPLOADS_DIR } from './config.ts';
import { HttpError } from './errors.ts';
import { fromSessionMessage, type LoggedEvent } from './events.ts';
import { stopPcSession, type LiveRegistry } from './live.ts';
import { type Attachment, prepareTurn } from './attachments.ts';
import { readPlanUsage } from './claude-usage.ts';
import { PanelSession, probeCommands, withProbe, type PanelSessionOptions } from './panel-session.ts';
import { searchProjectFiles } from './project-files.ts';
import { createProjectDir, expandHome, isDirectory, listFolders, type FolderListing } from './project-folders.ts';
import type { PlanUsage } from './system.ts';
import { imageStore, type StoredImage } from './images.ts';
import { transcriptCwd, transcriptEfforts, transcriptFile } from './transcript.ts';
import { pcOffice, type OfficeSnapshot } from './office.ts';
import type { Fork, MetaStore } from './meta.ts';
import { snapshotOf, type TeamSnapshot, type TeamStore } from './teams.ts';
import { tagOf, type WorkspaceStore, type WorkspaceTag } from './workspaces.ts';
import type { ResumeEntry } from './updater.ts';

export type CatalogState = 'running' | 'waiting' | 'idle' | 'stopped';

/** Um setor da salinha: uma conversa aberta (no painel ou no PC) e quem trabalha nela. */
export type OfficeRoom = Pick<CatalogEntry, 'sessionId' | 'title' | 'cwd' | 'state' | 'waitingFor' | 'team' | 'workspace'> &
  OfficeSnapshot & { owner: 'panel' | 'pc' };

export type CatalogEntry = {
  sessionId: string;
  title: string;
  cwd?: string;
  gitBranch?: string;
  lastModified: number;
  /** Quem tem o processo vivo: o painel, o PC (terminal/VSCode/background) ou ninguém. */
  owner: 'panel' | 'pc' | null;
  state: CatalogState;
  waitingFor?: string;
  pcKind?: 'interactive' | 'background';
  /** De onde esta conversa bifurcou, para a lista e o cabeçalho marcarem. */
  forkedFrom?: { sessionId: string; title?: string };
  /** Aprovações e perguntas aguardando resposta (só sessões do painel). */
  pending?: { requestId: string; kind: 'approval' | 'question' }[];
  /** Subagentes trabalhando agora (só sessões do painel). */
  agents?: number;
  /** Turno em andamento sem ferramenta aberta: pensando, não executando (só sessões do painel). */
  thinking?: boolean;
  /** Outras tarefas em segundo plano (monitores, comandos): o turno acabou, mas o Claude vai voltar. */
  tasks?: { type: string; description: string }[];
  pinned?: boolean;
  /** O nome que você deu ao claudinho da conversa; sem ele, o app mostra o sorteado. */
  claudinhoName?: string;
  /** O id de onde vem o claudinho desta conversa, quando ela continua outra (ver meta.ts). */
  look?: string;
  /** O time de agentes da conversa (só as que começaram no painel com um). */
  team?: TeamSnapshot;
  /** O workspace de que a conversa faz parte. */
  workspace?: WorkspaceTag;
};

type RunOptions = Pick<PanelSessionOptions, 'model' | 'effort' | 'permissionMode'>;

/** Sem `at`: a leitura ainda está em andamento. */
type SavedCache = { at?: number; rows: Promise<SDKSessionInfo[]> };

const SAVED_CACHE_MS = 5_000;
const COMMANDS_CACHE_MS = 10 * 60_000;
const DELIVERED_MAX = 500;
// Históricos já convertidos em eventos (~300 KB cada), dos mais recentes.
const HISTORY_CACHE_MAX = 12;

export type CommandInfo = { name: string; description: string; argumentHint: string; builtin: boolean };
export type ModelOption = { value: string; resolvedModel?: string; displayName: string; efforts: string[] };

// Comandos internos que no terminal abrem telas interativas; pelo celular não fazem sentido.
const HIDDEN_BUILTINS = new Set([
  'add-dir', 'agents', 'auto-mode-setup', 'bug', 'color', 'config', 'design-consent', 'design-revoke',
  'doctor', 'exit', 'export', 'extra-usage', 'feedback', 'focus', 'heapdump', 'hooks', 'ide', 'import',
  'insights', 'keybindings', 'list-agents', 'login', 'logout', 'mcp', 'memory', 'output-style',
  'permissions', 'plugin', 'plugins', 'privacy-settings', 'quit', 'release-notes', 'resume', 'statusline',
  'tasks', 'team-onboarding', 'terminal-setup', 'theme', 'upgrade', 'usage-credits', 'vim',
]);

/** Skills do usuário e de plugins primeiro; comandos internos depois. */
function filterCommands(list: SlashCommand[]): CommandInfo[] {
  return list
    .filter((c) => !c.name.startsWith('_') && !(c.builtin && HIDDEN_BUILTINS.has(c.name)))
    .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, builtin: Boolean(c.builtin) }))
    .sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
}

export class Manager extends EventEmitter {
  private readonly sessions = new Map<string, PanelSession>();
  private savedCache?: SavedCache;
  /** Em ordem de uso: a primeira é a que sai quando passa do limite. */
  private readonly historyCache = new Map<string, { version: string; events: Promise<readonly LoggedEvent[]> }>();
  private readonly imageReloads = new Map<string, Promise<unknown>>();
  private readonly commandsCache = new Map<string, { at: number; list: Promise<CommandInfo[]> }>();
  private modelsCache?: { at: number; list: Promise<ModelOption[]> };
  /** `clientId` das últimas mensagens aceitas, em ordem de chegada. */
  private readonly delivered = new Set<string>();
  private readonly live: LiveRegistry;
  private readonly meta: MetaStore;
  private readonly teams: TeamStore;
  private readonly workspaces: WorkspaceStore;

  constructor(live: LiveRegistry, meta: MetaStore, teams: TeamStore, workspaces: WorkspaceStore) {
    super();
    this.live = live;
    this.meta = meta;
    this.teams = teams;
    this.workspaces = workspaces;
    live.on('change', () => this.emit('catalog'));
  }

  get(sessionId: string): PanelSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new HttpError(404, 'not_open_in_panel');
    return session;
  }

  find(sessionId: string): PanelSession | undefined {
    return this.sessions.get(sessionId);
  }

  async catalog(): Promise<CatalogEntry[]> {
    const saved = await this.saved();
    const byId = new Map<string, CatalogEntry>();

    for (const s of saved) {
      const title = s.customTitle ?? s.summary;
      byId.set(s.sessionId, {
        sessionId: s.sessionId,
        title: isDerivedName(title, s.cwd) ? (s.firstPrompt ?? title) : title,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        lastModified: s.lastModified,
        owner: null,
        state: 'stopped',
      });
    }

    for (const l of this.live.all()) {
      const entry = byId.get(l.sessionId) ?? {
        sessionId: l.sessionId,
        title: l.name && !isDerivedName(l.name, l.cwd) ? l.name : '(sem título)',
        cwd: l.cwd,
        lastModified: l.startedAt,
        owner: null,
        state: 'stopped' as const,
      };
      entry.owner = 'pc';
      entry.state = l.status === 'busy' ? 'running' : l.status;
      entry.waitingFor = l.waitingFor;
      entry.pcKind = l.kind;
      byId.set(l.sessionId, entry);
    }

    // Sessões do painel por último: o processo headless também pode aparecer em `agents --json`.
    for (const s of this.sessions.values()) {
      const entry = byId.get(s.id) ?? {
        sessionId: s.id,
        title: s.label ?? '(nova sessão)',
        cwd: s.cwd,
        lastModified: s.startedAt,
        owner: null,
        state: 'stopped' as const,
      };
      // Até o Claude Code gerar o título, o rótulo do painel (ou o início do prompt) descreve melhor.
      if (s.label && (entry.title === '(sem título)' || isDerivedName(entry.title, entry.cwd))) entry.title = s.label;
      entry.owner = 'panel';
      entry.state = s.state === 'starting' ? 'running' : s.state === 'exited' ? 'stopped' : s.state;
      entry.agents = s.state === 'exited' ? undefined : s.agents.active || undefined;
      entry.thinking = s.thinking || undefined;
      const tasks = s.state === 'exited' ? [] : s.background.list.filter((t) => t.type !== 'local_agent');
      entry.tasks = tasks.length ? tasks.map((t) => ({ type: t.type, description: t.description })) : undefined;
      // Turno encerrado com subagentes em segundo plano: a sessão ainda está trabalhando.
      if (entry.state === 'idle' && entry.agents) entry.state = 'running';
      entry.waitingFor = s.waitingFor;
      entry.pcKind = undefined;
      entry.pending = s.pendingRequests();
      byId.set(s.id, entry);
    }

    // Os títulos antes de tirar as esvaziadas: a que continua uma delas pode precisar do título de lá.
    const titles = new Map([...byId].map(([id, e]) => [id, e.title]));
    // As esvaziadas por um /clear saem: quem segue é a conversa nova, com o mesmo claudinho.
    for (const id of byId.keys()) if (this.meta.isCleared(id) && !this.sessions.has(id)) byId.delete(id);
    for (const entry of byId.values()) {
      if (this.meta.isPinned(entry.sessionId)) entry.pinned = true;
      const look = this.meta.lookOf(entry.sessionId);
      if (look) {
        entry.look = look;
        // Depois de um /clear, a primeira mensagem da conversa nova é o próprio comando, e o título sairia
        // "/clear": até ela ter um de verdade, fica o da conversa de onde ela veio.
        const before = titles.get(look);
        if (/^\/[\w:-]+\s*$/.test(entry.title) && before && !before.startsWith('/')) entry.title = before;
      }
      const name = this.meta.nameOf(entry.sessionId);
      if (name) entry.claudinhoName = name;
      const team = this.meta.teamOf(entry.sessionId);
      if (team) entry.team = team;
      const wsId = this.meta.workspaceOf(entry.sessionId);
      const ws = wsId ? this.workspaces.find(wsId) : undefined;
      if (ws) entry.workspace = tagOf(ws);
      const fork = this.meta.forkOf(entry.sessionId);
      if (fork) entry.forkedFrom = { sessionId: fork.from, title: byId.get(fork.from)?.title };
    }
    return [...byId.values()].sort((a, b) => b.lastModified - a.lastModified);
  }

  /** O id de onde vem o claudinho da conversa, para o aviso de id novo levar junto. */
  lookOf(sessionId: string): string | undefined {
    return this.meta.lookOf(sessionId);
  }

  /** A salinha: cada conversa aberta e o que cada claudinho dela faz agora. */
  async office(): Promise<OfficeRoom[]> {
    const open = (await this.catalog()).filter((e): e is CatalogEntry & { owner: 'panel' | 'pc' } => e.owner !== null);
    return Promise.all(
      open.map(async (e) => {
        const live = this.live.get(e.sessionId);
        const empty: OfficeSnapshot = { workers: [], events: [] };
        const snap =
          e.owner === 'panel'
            ? (this.sessions.get(e.sessionId)?.office() ?? empty)
            : live
              ? await pcOffice(e.sessionId, live).catch(() => empty)
              : empty;
        return { sessionId: e.sessionId, title: e.title, cwd: e.cwd, state: e.state, waitingFor: e.waitingFor, owner: e.owner, team: e.team, workspace: e.workspace, ...snap };
      }),
    );
  }

  /** As mensagens que a bifurcação herdou: as da origem até o ponto do corte, inclusive. */
  private async inherited(fork: Fork): Promise<Awaited<ReturnType<typeof getSessionMessages>>> {
    const origin = await getSessionMessages(fork.from);
    if (!fork.at) return origin;
    const cut = origin.findIndex((m) => m.uuid === fork.at);
    return cut < 0 ? origin : origin.slice(0, cut + 1);
  }

  /**
   * Histórico salvo. Com a sessão aberta no painel, só o que existia antes do processo:
   * o restante o cliente recebe pelo log de eventos, sem duplicar.
   *
   * Ler um transcript grande leva ~1 s, e o app pede o histórico a cada conversa aberta (e de 4 em
   * 4 s enquanto ela trabalha no PC): o resultado fica guardado até mudar, e pedidos iguais ao mesmo
   * tempo esperam a mesma leitura. É compartilhado entre quem pede, por isso só leitura.
   */
  async history(sessionId: string, limit = 300): Promise<readonly LoggedEvent[]> {
    const open = this.sessions.get(sessionId);
    const fork = this.meta.forkOf(sessionId);
    // O `runId`: reaberta no painel, o corte em `priorMessages` é outro.
    const key = [sessionId, limit, open?.runId ?? '', fork ? `${fork.from}@${fork.at ?? ''}` : ''].join('|');
    const version = await this.historyVersion(sessionId, Boolean(open), fork);
    const hit = this.historyCache.get(key);
    this.historyCache.delete(key);
    if (hit?.version === version) {
      // Reinserida no fim: a mais recente é a última a sair.
      this.historyCache.set(key, hit);
      return hit.events;
    }
    const events = this.readHistory(sessionId, limit, open?.priorMessages, fork);
    this.historyCache.set(key, { version, events });
    if (this.historyCache.size > HISTORY_CACHE_MAX) this.historyCache.delete(this.historyCache.keys().next().value!);
    events.catch(() => {
      if (this.historyCache.get(key)?.events === events) this.historyCache.delete(key);
    });
    return events;
  }

  /**
   * Quando o histórico guardado deixa de valer. Aberta no painel, ele é o que existia antes do
   * processo e não muda enquanto ele vive, embora o arquivo cresça a cada turno: vale até ela fechar
   * (a chave leva o `runId`). Fechada ou no PC, vale enquanto o transcript tiver o mesmo tamanho e
   * data. Numa bifurcação contam também os da origem, de onde ela tira o histórico até ter turno próprio.
   */
  private async historyVersion(sessionId: string, open: boolean, fork?: Fork): Promise<string> {
    if (open && !fork) return '';
    const files = await Promise.all([sessionId, ...(fork ? [fork.from] : [])].map(transcriptFile));
    return files.map((f) => (f ? `${f.size}:${f.mtimeMs}` : '-')).join('|');
  }

  /** Lê o transcript e converte em eventos; as imagens achadas vão para o cache de imagens. */
  private async readHistory(sessionId: string, limit: number, prior?: number, fork?: Fork): Promise<LoggedEvent[]> {
    let messages = await getSessionMessages(sessionId);
    // De qual transcript sai o esforço de cada resposta: o da própria conversa, ou o da origem enquanto ela herda.
    let source = sessionId;
    // Bifurcação sem turno próprio: o Claude Code só grava o log dela na primeira mensagem, então
    // até lá o que se mostra é o histórico herdado da origem, cortado no ponto da bifurcação. Vem
    // do meta, e não da sessão viva, para continuar valendo depois que ela é fechada.
    if (messages.length === 0 && fork) {
      messages = await this.inherited(fork);
      source = fork.from;
    } else if (prior !== undefined) messages = messages.slice(0, prior);
    const efforts = await transcriptEfforts(source);
    const events = messages
      .slice(-limit)
      .flatMap((m) => fromSessionMessage(m, imageStore.sink(sessionId, m.uuid), efforts.get(m.uuid)).map((e) => ({ ...e, uuid: m.uuid })));
    // Histórico salvo não tem seq; numerado localmente só para o cliente ordenar.
    return events.map((e, i) => ({ ...e, seq: i + 1, ts: 0 }) as LoggedEvent);
  }

  /**
   * Diretórios candidatos para sessões novas: subpastas das raízes, as pastas que você adicionou (as
   * que ainda existem) e cwds de conversas salvas dentro delas.
   */
  async projects(): Promise<string[]> {
    const fromSessions = (await this.saved()).map((s) => s.cwd).filter((c): c is string => Boolean(c));
    const fromRoots = await Promise.all(
      PROJECT_ROOTS.map(async (root) => {
        const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
        return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => join(root, e.name));
      }),
    );
    const added = (await Promise.all(this.meta.addedProjects().map(async (p) => ((await isDirectory(p)) ? p : null)))).filter(
      (p): p is string => p !== null,
    );
    return [...new Set([...fromSessions, ...fromRoots.flat(), ...added])].filter((d) => this.isProjectDir(d)).sort();
  }

  /** De onde vêm os projetos: as raízes (a primeira é onde pasta nova é criada) e as pastas adicionadas. */
  projectSources(): { roots: string[]; added: string[] } {
    return { roots: PROJECT_ROOTS, added: this.meta.addedProjects() };
  }

  /** Pasta nova de projeto na primeira raiz (com `git init`, se pedido). */
  async createProject(name: string, git: boolean): Promise<{ path: string }> {
    const root = PROJECT_ROOTS[0];
    if (!root) throw new HttpError(400, 'no_project_root');
    return { path: await createProjectDir(root, name, git) };
  }

  /**
   * Uma pasta que já existe, em qualquer lugar, vira projeto: aparece na lista e aceita conversas.
   * As que ficam direto numa raiz já aparecem sozinhas; as de mais fundo (~/Projects/cliente/app)
   * são guardadas como as de fora; a pasta pessoal é o "Sem projeto", e as de cima dela
   * (/home, a raiz do disco) não são projeto.
   */
  async addProject(path: string): Promise<{ path: string }> {
    const dir = expandHome(path);
    // A pasta pessoal, ou uma que a contenha, liberaria conversas em qualquer pasta sua.
    if (dir === homedir() || homedir().startsWith(dir.endsWith(sep) ? dir : dir + sep)) throw new HttpError(400, 'folder_not_project');
    if (!(await isDirectory(dir))) throw new HttpError(404, 'folder_not_found');
    if (!listedByRoots(dir)) await this.meta.setProjectAdded(dir, true);
    return { path: dir };
  }

  /** Tira da lista uma pasta adicionada (a pasta fica no PC, intacta). */
  async removeProject(path: string): Promise<void> {
    await this.meta.setProjectAdded(resolve(path), false);
  }

  folders(path: string | undefined): Promise<FolderListing> {
    return listFolders(path ?? '~');
  }

  /** Dentro de uma raiz ou de uma pasta adicionada. */
  private isProjectDir(dir: string): boolean {
    return isUnderRoots(dir) || isUnderAny(dir, this.meta.addedProjects());
  }

  /** Onde dá para abrir conversa: projetos e a pasta pessoal em si (não as subpastas dela). */
  private isAllowedCwd(dir: string): boolean {
    return dir === homedir() || this.isProjectDir(dir);
  }

  async create(
    opts: RunOptions & { cwd?: string; prompt: string; title?: string; attachments?: Attachment[]; teamId?: string; workspaceId?: string },
  ): Promise<PanelSession> {
    const { prompt, attachments, teamId, workspaceId, ...rest } = opts;
    // O time vai copiado: editá-lo depois não muda esta conversa.
    const team = teamId ? snapshotOf(this.teams.get(teamId)) : undefined;
    const ws = workspaceId ? this.workspaces.get(workspaceId) : undefined;
    // Sem projeto: a sessão abre na pasta pessoal (no workspace, no projeto principal dele).
    const cwd = resolve(opts.cwd || ws?.projects[0] || homedir());
    if (!this.isAllowedCwd(cwd)) throw new HttpError(403, 'cwd_outside_roots', { roots: PROJECT_ROOTS });
    const info = await stat(cwd).catch(() => null);
    if (!info?.isDirectory()) throw new HttpError(400, 'cwd_not_a_directory');
    const workspace = ws ? ((await this.workspaces.context(ws.id, cwd)) ?? undefined) : undefined;
    const session = this.adopt(new PanelSession({ ...rest, cwd, team, workspace, label: opts.title || prompt.slice(0, 80) }));
    if (team) await this.meta.setTeam(session.id, team);
    if (ws) await this.meta.setWorkspace(session.id, ws.id);
    await this.send(session.id, prompt, attachments);
    return session;
  }

  /**
   * O que acompanha uma mensagem para o Claude sem aparecer no chat: o conteúdo dos `TODO:n` que ela
   * menciona (ver todos.ts). Posto pelo index.ts, que tem a lista.
   */
  todoContext?: (cwd: string, text: string) => Promise<string | null>;

  async send(sessionId: string, text: string, attachments?: Attachment[], clientId?: string): Promise<void> {
    // Reenvio da fila do celular cuja resposta se perdeu no caminho: já foi entregue, não repete o turno.
    if (clientId && this.delivered.has(clientId)) return;
    const session = this.get(sessionId);
    if (clientId) {
      this.delivered.add(clientId);
      if (this.delivered.size > DELIVERED_MAX) this.delivered.delete(this.delivered.values().next().value!);
    }
    try {
      const turn = await prepareTurn(session.id, text, attachments, imageStore.sink(session.id, `u${Date.now()}`));
      const context = (await this.todoContext?.(session.cwd, text).catch(() => null)) ?? undefined;
      session.send(turn.text, { blocks: turn.blocks, images: turn.images, clientId, context });
    } catch (err) {
      if (clientId) this.delivered.delete(clientId);
      throw err;
    }
  }

  /** Comandos e skills para o autocompletar do "/", por projeto. */
  async commands(cwd: string): Promise<CommandInfo[]> {
    const dir = await this.knownCwd(cwd);
    const open = [...this.sessions.values()].find((s) => s.cwd === dir);
    if (open) return filterCommands(await open.commands());
    const hit = this.commandsCache.get(dir);
    if (hit && Date.now() - hit.at < COMMANDS_CACHE_MS) return hit.list;
    const list = probeCommands(dir).then(filterCommands);
    this.commandsCache.set(dir, { at: Date.now(), list });
    list.catch(() => this.commandsCache.delete(dir));
    return list;
  }

  /** Modelos e níveis de esforço: pela sessão aberta no painel, se houver; senão por uma sonda (cache de 10 min). */
  async models(): Promise<ModelOption[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < COMMANDS_CACHE_MS) return this.modelsCache.list;
    const open = this.sessions.values().next().value;
    const list = (open ? open.models() : withProbe(homedir(), (q) => q.supportedModels())).then((models) =>
      models.map((m) => ({
        value: m.value,
        resolvedModel: m.resolvedModel,
        displayName: m.displayName,
        efforts: m.supportedEffortLevels ?? [],
      })),
    );
    this.modelsCache = { at: Date.now(), list };
    list.catch(() => (this.modelsCache = undefined));
    return list;
  }

  /** Limites do plano: pela sessão aberta no painel, se houver; senão por uma sonda. */
  async planUsage(): Promise<PlanUsage> {
    const open = this.sessions.values().next().value;
    return open ? open.planUsage() : withProbe(homedir(), readPlanUsage);
  }

  /** Sem conversa aberta no painel, consultar o uso do plano sobe um Claude Code inteiro (a sonda). */
  planNeedsProbe(): boolean {
    return this.sessions.size === 0;
  }

  /** Arquivos do projeto para o autocompletar do "@". */
  async files(cwd: string, query: string): Promise<string[]> {
    return searchProjectFiles(await this.knownCwd(cwd), query);
  }

  /**
   * Apaga a conversa do Claude Code (transcript e subagentes), os anexos e o "fixado".
   * Recusa se ela estiver aberta no PC; aberta no painel, o processo é encerrado antes.
   */
  async delete(sessionId: string): Promise<void> {
    const own = this.sessions.get(sessionId);
    if (!own) {
      await this.live.refresh();
      if (this.live.get(sessionId)) throw new HttpError(409, 'live_on_pc');
    }
    await own?.shutdown();
    await deleteSession(sessionId);
    await rm(join(UPLOADS_DIR, sessionId), { recursive: true, force: true });
    if (this.meta.isPinned(sessionId)) await this.meta.setPinned(sessionId, false);
    if (this.meta.nameOf(sessionId)) await this.meta.setName(sessionId, null);
    if (this.meta.teamOf(sessionId)) await this.meta.setTeam(sessionId, undefined);
    if (this.meta.workspaceOf(sessionId)) await this.meta.setWorkspace(sessionId, undefined);
    this.savedCache = undefined;
    this.emit('catalog');
  }

  /** Fixa ou desafixa no topo da lista (só no painel). */
  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    await this.meta.setPinned(sessionId, pinned);
    this.emit('catalog');
  }

  /** O nome do claudinho da conversa; `null` volta ao sorteado. Só do painel, como o fixar. */
  async setClaudinhoName(sessionId: string, name: string | null): Promise<void> {
    await this.meta.setName(sessionId, name);
    this.emit('catalog');
  }

  /** Título gravado no próprio Claude Code: aparece também no /resume do terminal. */
  async rename(sessionId: string, title: string): Promise<void> {
    await renameSession(sessionId, title.trim());
    this.savedCache = undefined;
    this.emit('catalog');
  }

  /** Imagem do chat; se saiu do cache (ou o servidor reiniciou), recarrega o histórico e tenta de novo. */
  async image(sessionId: string, key: string): Promise<StoredImage> {
    let image = imageStore.get(sessionId, key);
    if (!image) {
      await this.reloadImages(sessionId);
      image = imageStore.get(sessionId, key);
    }
    if (!image) throw new HttpError(404, 'image_not_found');
    return image;
  }

  /**
   * Relê o transcript só para devolver as imagens ao cache, por fora do cache do histórico (que
   * guarda os eventos, não as imagens). As que faltam ao mesmo tempo esperam a mesma leitura.
   */
  private reloadImages(sessionId: string): Promise<unknown> {
    let reload = this.imageReloads.get(sessionId);
    if (!reload) {
      const open = this.sessions.get(sessionId);
      reload = this.readHistory(sessionId, 5_000, open?.priorMessages, this.meta.forkOf(sessionId))
        .catch(() => [])
        .finally(() => this.imageReloads.delete(sessionId));
      this.imageReloads.set(sessionId, reload);
    }
    return reload;
  }

  async updateSettings(
    sessionId: string,
    patch: { model?: string; effort?: EffortLevel; permissionMode?: PermissionMode },
  ): Promise<void> {
    const session = this.get(sessionId);
    if (patch.model) await session.setModel(patch.model);
    if (patch.effort) await session.setEffort(patch.effort);
    if (patch.permissionMode) await session.setPermissionMode(patch.permissionMode);
  }

  /** Só diretórios de projetos conhecidos: raízes configuradas, pastas adicionadas, a pasta pessoal ou cwd de alguma conversa. */
  async knownCwd(cwd: string): Promise<string> {
    const dir = resolve(cwd);
    if (this.isAllowedCwd(dir) || (await this.saved()).some((s) => s.cwd === dir)) return dir;
    throw new HttpError(403, 'unknown_project');
  }

  /** Retoma uma conversa salva no painel. Nunca em paralelo com um processo vivo no PC. */
  /**
   * Abre a conversa no painel. Com `fork`, ela vira uma conversa nova e a original fica intacta;
   * junto com `at`, a nova nasce com o histórico só até aquele ponto — é a bifurcação no meio da
   * conversa, para seguir por outro caminho sem perder o que já estava escrito.
   */
  async open(sessionId: string, opts: RunOptions & { fork?: boolean; at?: string } = {}): Promise<PanelSession> {
    const own = this.sessions.get(sessionId);
    if (own && !opts.fork) return own;

    const info = await getSessionInfo(sessionId);
    const cwd = info && (info.cwd ?? (await transcriptCwd(sessionId)));
    if (!cwd) throw new HttpError(404, 'session_not_found');

    if (!opts.fork) {
      await this.live.refresh();
      const live = this.live.get(sessionId);
      if (live) {
        throw new HttpError(409, 'live_on_pc', { status: live.status, waitingFor: live.waitingFor, kind: live.kind });
      }
    }
    const messages = await getSessionMessages(sessionId);
    // Bifurcar no meio: o corte fica no último registro que fica de pé, e o resto é descartado.
    const cut = opts.at ? messages.findIndex((m) => m.uuid === opts.at) : -1;
    if (opts.at && cut < 0) throw new HttpError(404, 'fork_point_not_found');
    const priorMessages = cut >= 0 ? cut + 1 : messages.length;
    const session = this.adopt(
      new PanelSession({
        ...opts,
        cwd,
        resume: sessionId,
        resumeAt: opts.at,
        priorMessages,
        origin: opts.fork ? sessionId : undefined,
        // Retomada (ou bifurcada) com o time que ela tinha e o contexto atual do workspace dela.
        team: this.meta.teamOf(sessionId),
        workspace: await this.workspaceContext(sessionId, cwd),
      }),
    );
    // A bifurcação já nasce com ID próprio, então a origem é gravada aqui mesmo.
    if (opts.fork) await this.meta.setFork(session.id, { from: sessionId, at: opts.at });
    if (opts.fork && session.team) await this.meta.setTeam(session.id, session.team);
    const wsId = this.meta.workspaceOf(sessionId);
    if (opts.fork && wsId) await this.meta.setWorkspace(session.id, wsId);
    return session;
  }

  /**
   * Troca (ou tira, com `null`) o time de uma conversa que já começou. O SDK fixa os subagentes quando o
   * processo sobe: aberta no painel, ela precisa estar parada, e o processo é encerrado e retomado com
   * o time novo, com os mesmos modelo, esforço e modo. Fechada (ou no PC), o time vale quando ela for
   * aberta no painel.
   */
  async changeTeam(sessionId: string, teamId: string | null): Promise<void> {
    const team = teamId ? snapshotOf(this.teams.get(teamId)) : undefined;
    const own = this.sessions.get(sessionId);
    if (own) await own.release();
    await this.meta.setTeam(sessionId, team);
    if (own) {
      const { model, effort, permissionMode } = own.settings;
      await this.open(sessionId, {
        model,
        effort: (effort ?? undefined) as EffortLevel | undefined,
        permissionMode: permissionMode as PermissionMode | undefined,
      });
    }
    this.emit('catalog');
  }

  /** O contexto do workspace da conversa, montado do workspace como ele está agora. */
  private async workspaceContext(sessionId: string, cwd: string): Promise<{ prompt: string; directories: string[] } | undefined> {
    const wsId = this.meta.workspaceOf(sessionId);
    return wsId ? ((await this.workspaces.context(wsId, cwd)) ?? undefined) : undefined;
  }

  /** Assumir: encerra a sessão ociosa no PC e a retoma no painel. */
  async takeOver(sessionId: string, opts: RunOptions = {}): Promise<PanelSession> {
    const own = this.sessions.get(sessionId);
    if (own) return own;

    await this.live.refresh();
    const live = this.live.get(sessionId);
    if (live) {
      await stopPcSession(live);
      await this.live.refresh();
      if (this.live.get(sessionId)) throw new HttpError(409, 'still_live_on_pc');
    }
    return this.open(sessionId, opts);
  }

  /** Liberar: encerra o processo do painel para a sessão poder ser retomada no terminal. */
  async release(sessionId: string): Promise<{ resumeCommand: string }> {
    const session = this.get(sessionId);
    await session.release();
    return { resumeCommand: `cd ${shellQuote(session.cwd)} && claude --resume ${session.id}` };
  }

  /** Conversas abertas no painel com os ajustes atuais, para reabrir depois de um reinício. */
  resumable(): ResumeEntry[] {
    return [...this.sessions.values()].filter((s) => s.state !== 'exited').map((s) => ({ sessionId: s.id, ...s.settings }));
  }

  /** Reabre, sem mandar nada, as conversas que estavam no painel antes do reinício. */
  async reopen(entries: ResumeEntry[]): Promise<string[]> {
    const opened: string[] = [];
    for (const e of entries) {
      try {
        const opts = { model: e.model, effort: (e.effort ?? undefined) as EffortLevel | undefined, permissionMode: e.permissionMode as PermissionMode | undefined };
        opened.push((await this.open(e.sessionId, opts)).id);
      } catch {
        // Apagada, aberta no PC nesse meio-tempo…: fica fechada.
      }
    }
    return opened;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.shutdown()));
  }

  private adopt(session: PanelSession): PanelSession {
    this.sessions.set(session.id, session);
    this.savedCache = undefined;
    session.on('rekey', (from: string, to: string) => {
      this.sessions.delete(from);
      this.sessions.set(to, session);
      // A bifurcação só ganha ID aqui; antes disso não havia a quem amarrar a origem. Ela é outra
      // conversa, com outro claudinho; qualquer outro id novo (o /clear, uma sessão retomada) é a mesma
      // conversa seguindo, e veste o mesmo claudinho.
      if (session.origin) void this.meta.setFork(to, { from: session.origin, at: session.resumeAt });
      else void this.meta.inherit(to, from);
      // O time e o workspace seguem com ela, num caso e no outro.
      if (session.team) void this.meta.setTeam(to, session.team);
      const wsId = this.meta.workspaceOf(session.origin ?? from);
      if (wsId) void this.meta.setWorkspace(to, wsId);
      this.emit('rekey', from, to);
      this.emit('catalog');
    });
    session.on('cleared', (from: string, to: string) => {
      void this.meta.setCleared(from, to);
      this.emit('catalog');
    });
    session.on('event', (ev: LoggedEvent) => this.emit('event', session.id, ev, session.runId));
    session.on('delta', (text: string) => this.emit('delta', session.id, text));
    session.on('state', () => this.emit('catalog'));
    session.on('exit', () => {
      this.sessions.delete(session.id);
      this.savedCache = undefined;
      this.emit('catalog');
    });
    this.emit('catalog');
    return session;
  }

  /** Conversas salvas, com cache curto; quem pede enquanto a leitura anda espera a mesma. */
  private saved(): Promise<SDKSessionInfo[]> {
    const hit = this.savedCache;
    if (hit && (hit.at === undefined || Date.now() - hit.at < SAVED_CACHE_MS)) return hit.rows;
    const entry: SavedCache = { rows: listSaved() };
    this.savedCache = entry;
    entry.rows.then(
      () => (entry.at = Date.now()),
      () => {
        if (this.savedCache === entry) this.savedCache = undefined;
      },
    );
    return entry.rows;
  }
}

async function listSaved(): Promise<SDKSessionInfo[]> {
  const rows = await listSessions();
  // O SDK não achou o `cwd` (primeira mensagem com imagem, ver transcriptCwd): lê do transcript.
  await Promise.all(rows.filter((r) => !r.cwd).map(async (r) => (r.cwd = await transcriptCwd(r.sessionId))));
  return rows;
}

function isUnderRoots(dir: string): boolean {
  return isUnderAny(dir, PROJECT_ROOTS);
}

/** Subpasta direta (e não oculta) de uma raiz: já entra na lista de projetos sem ser guardada. */
function listedByRoots(dir: string): boolean {
  const abs = resolve(dir);
  return !basename(abs).startsWith('.') && PROJECT_ROOTS.some((root) => dirname(abs) === resolve(root));
}

function isUnderAny(dir: string, roots: string[]): boolean {
  const abs = resolve(dir);
  return roots.some((root) => abs === resolve(root) || abs.startsWith(resolve(root) + sep));
}

/**
 * Nome provisório que o Claude Code dá à sessão ("cald-86") até gerar o título;
 * nesse intervalo o primeiro prompt descreve melhor a conversa.
 */
function isDerivedName(title: string, cwd?: string): boolean {
  if (!cwd) return false;
  const slug = basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return new RegExp(`^${slug}-[0-9a-f]{2}$`).test(title);
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
