import { EventEmitter } from 'node:events';
import { readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { PROJECT_ROOTS, UPLOADS_DIR } from './config.ts';
import { HttpError } from './errors.ts';
import type { LoggedEvent } from './events.ts';
import { type Attachment, prepareTurn } from './attachments.ts';
import { PanelSession, type PanelSessionOptions } from './panel-session.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type { AgentProvider, CommandInfo, ExternalSession, ModelOption, SavedMessage, SavedSession } from './providers/types.ts';
import { searchProjectFiles } from './project-files.ts';
import { createProjectDir, expandHome, isDirectory, listFolders, type FolderListing } from './project-folders.ts';
import type { PlanUsage } from './system.ts';
import { imageStore, type StoredImage } from './images.ts';
import type { Device, OriginLog } from './origins.ts';
import { pluginDir, removePlugin, writePlugin, type Habilidade, type HabilidadeInput, type HabilidadeStore } from './habilidades.ts';
import type { Fork, MetaStore } from './meta.ts';
import type { MessageQueues, QueuedMessage, QueueItemView } from './message-queue.ts';
import { snapshotOf, type TeamSnapshot, type TeamStore } from './teams.ts';
import { tagOf, type WorkspaceStore, type WorkspaceTag } from './workspaces.ts';
import type { ResumeEntry } from './updater.ts';
import type { EditrMcpContext, McpServerSpec } from './editr-mcp.ts';
import {
  createWorktree,
  listedWorktree,
  listWorktrees,
  mergeWorktree,
  pruneWorktrees,
  removeWorktree,
  repoRootOf,
  tagOf as worktreeTag,
  unsaved,
  worktreeOf,
  worktreePrompt,
  worktreeStatus,
  type ListedWorktree,
  type WorktreeInfo,
  type WorktreeRef,
  type WorktreeStatus,
  type WorktreeTag,
} from './worktrees.ts';

export type CatalogState = 'running' | 'waiting' | 'idle' | 'stopped';

export type CatalogEntry = {
  sessionId: string;
  /** O agente da conversa (ver providers/). */
  provider: string;
  title: string;
  cwd?: string;
  gitBranch?: string;
  lastModified: number;
  /** Quem tem o processo vivo: o painel, o PC (terminal/VSCode/background) ou ninguém. */
  owner: 'panel' | 'pc' | null;
  state: CatalogState;
  waitingFor?: string;
  pcKind?: 'interactive' | 'background';
  /** Aberta fora do painel: de onde, e se dá para fechar lá e continuar aqui (ver ExternalSession). */
  pcVia?: 'terminal' | 'vscode' | 'desktop' | 'app';
  pcTakeover?: boolean;
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
  /** O worktree em que a conversa roda, separada das outras do mesmo projeto (ver worktrees.ts). */
  worktree?: WorktreeTag;
  /** As mensagens esperando a vez, na ordem (ver message-queue.ts). */
  queue?: QueueItemView[];
  /** A fila não anda sozinha: o turno foi interrompido, deu erro ou o serviço reiniciou. */
  queuePaused?: boolean;
};

type RunOptions = Pick<PanelSessionOptions, 'model' | 'effort' | 'permissionMode'>;

/** Uma conversa salva, com o agente que a guarda. */
type SavedRow = SavedSession & { provider: AgentProvider };
/** Uma conversa aberta fora do painel, com o agente dela. */
type ExternalRow = ExternalSession & { provider: AgentProvider };

/** Sem `at`: a leitura ainda está em andamento. */
type SavedCache = { at?: number; rows: Promise<SavedRow[]> };

const SAVED_CACHE_MS = 5_000;
const DELIVERED_MAX = 500;
// Históricos já convertidos em eventos (~300 KB cada), dos mais recentes.
const HISTORY_CACHE_MAX = 12;

export class Manager extends EventEmitter {
  private readonly sessions = new Map<string, PanelSession>();
  private savedCache?: SavedCache;
  /** Em ordem de uso: a primeira é a que sai quando passa do limite. */
  private readonly historyCache = new Map<string, { version: string; events: Promise<readonly LoggedEvent[]> }>();
  private readonly imageReloads = new Map<string, Promise<unknown>>();
  /** `clientId` das últimas mensagens aceitas, em ordem de chegada. */
  private readonly delivered = new Set<string>();
  /** Times que o Claude pôs na própria conversa (`usar_time`, ver editr-mcp.ts): entram quando o turno acaba. */
  private readonly teamLater = new Map<PanelSession, string>();
  private readonly providers: ProviderRegistry;
  private readonly meta: MetaStore;
  private readonly habilidades: HabilidadeStore;
  private readonly teams: TeamStore;
  private readonly workspaces: WorkspaceStore;
  private readonly origins: OriginLog;
  private readonly queues: MessageQueues;
  /** Conversas mandando a próxima da fila agora: o estado ocioso pode chegar de novo antes de ela sair. */
  private readonly dispatching = new Set<string>();
  /** Conversas com o processo sendo trocado (time, workspace): a fila espera o novo subir. */
  private readonly restarting = new Set<string>();

  constructor(
    providers: ProviderRegistry,
    meta: MetaStore,
    teams: TeamStore,
    workspaces: WorkspaceStore,
    origins: OriginLog,
    habilidades: HabilidadeStore,
    queues: MessageQueues,
  ) {
    super();
    this.queues = queues;
    this.providers = providers;
    this.meta = meta;
    this.teams = teams;
    this.workspaces = workspaces;
    this.origins = origins;
    this.habilidades = habilidades;
    // As conversas abertas no terminal de cada agente: a lista e os avisos do PC acompanham.
    const externalChanged = () => {
      this.emit('catalog');
      this.emit('external');
    };
    for (const p of providers.all()) p.external?.on('change', externalChanged);
    // Um agente ligado ou desligado: as conversas dele entram ou saem da lista, e as do terminal passam (ou
    // deixam) de ser acompanhadas.
    providers.on('change', (toggled?: AgentProvider) => {
      if (toggled?.external) {
        if (providers.isEnabled(toggled.id)) void toggled.external.start().catch(() => undefined);
        else toggled.external.stop();
      }
      this.savedCache = undefined;
      externalChanged();
    });
    // Uma habilidade criada, editada ou para a lixeira: as conversas abertas no painel já veem.
    habilidades.on('change', () => {
      for (const s of this.sessions.values()) void this.refreshHabilidades(s);
    });
  }

  // ---- habilidades do edit.r (ver habilidades.ts) ----

  /** As habilidades que valem numa conversa em `cwd`, tirando as desligadas nela. */
  private habilidadesFor(cwd: string, sessionId?: string) {
    const off = new Set(sessionId ? this.meta.habilidadesOff(sessionId) : []);
    return this.habilidades.visibleIn(cwd).filter((h) => !off.has(h.id));
  }

  /** O plugin de uma conversa que vai abrir no painel: uma pasta nova com as habilidades dela. */
  private async habilidadesPlugin(cwd: string, sessionId?: string): Promise<string> {
    const dir = pluginDir();
    await writePlugin(dir, this.habilidadesFor(cwd, sessionId));
    return dir;
  }

  /** Refaz o plugin de uma conversa aberta e pede ao processo para reler, sem reiniciar. */
  private async refreshHabilidades(session: PanelSession): Promise<void> {
    if (!session.habilidades || session.state === 'exited') return;
    await writePlugin(session.habilidades, this.habilidadesFor(session.cwd, session.id));
    await session.reloadHabilidades().catch(() => undefined);
  }

  /** As globais, as do projeto de `cwd` e a lixeira, para o modal de habilidades. */
  async listHabilidades(cwd?: string) {
    return this.habilidades.list(cwd ? await this.knownCwd(cwd) : undefined);
  }

  async saveHabilidade(input: HabilidadeInput): Promise<Habilidade> {
    return this.habilidades.save({ ...input, project: input.project ? await this.knownCwd(input.project) : null });
  }

  /** O que está desligado nesta conversa (as do painel, e também uma do PC, que só vale quando ela vier para o painel). */
  sessionHabilidades(sessionId: string): { off: string[] } {
    return { off: this.meta.habilidadesOff(sessionId) };
  }

  async setSessionHabilidade(sessionId: string, id: string, on: boolean): Promise<{ off: string[] }> {
    const off = await this.meta.setHabilidade(sessionId, id, on);
    const open = this.sessions.get(sessionId);
    if (open) await this.refreshHabilidades(open);
    return { off };
  }

  get(sessionId: string): PanelSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new HttpError(404, 'not_open_in_panel');
    return session;
  }

  find(sessionId: string): PanelSession | undefined {
    return this.sessions.get(sessionId);
  }

  // ---- agentes (ver providers/) ----

  /** As conversas abertas fora do painel (terminal, VSCode), de todos os agentes ligados. */
  externals(): ExternalRow[] {
    return this.providers.enabled().flatMap((provider) => (provider.external?.all() ?? []).map((e) => ({ ...e, provider })));
  }

  /** A conversa aberta fora do painel, se for uma. */
  external(sessionId: string): ExternalRow | undefined {
    for (const provider of this.providers.enabled()) {
      const found = provider.external?.get(sessionId);
      if (found) return { ...found, provider };
    }
    return undefined;
  }

  /** Reconsulta as conversas abertas fora do painel, de todos os agentes ligados. */
  private async refreshExternals(): Promise<void> {
    await Promise.all(this.providers.enabled().map((p) => p.external?.refresh()));
  }

  /**
   * O agente de uma conversa: o do processo aberto no painel, o da conversa salva, o da aberta no
   * terminal ou, numa bifurcação ainda sem histórico próprio, o da origem; sem achar em lugar nenhum,
   * pergunta a cada agente ligado.
   */
  async providerOf(sessionId: string): Promise<AgentProvider> {
    const own = this.sessions.get(sessionId);
    if (own) return own.provider;
    const row = (await this.saved()).find((s) => s.sessionId === sessionId);
    if (row) return row.provider;
    const live = this.external(sessionId);
    if (live) return live.provider;
    const fork = this.meta.forkOf(sessionId);
    if (fork) return this.providerOf(fork.from);
    for (const p of this.providers.enabled()) if (await p.history.cwd(sessionId).catch(() => undefined)) return p;
    throw new HttpError(404, 'session_not_found');
  }

  async catalog(): Promise<CatalogEntry[]> {
    const saved = await this.saved();
    const byId = new Map<string, CatalogEntry>();

    for (const s of saved) {
      byId.set(s.sessionId, {
        sessionId: s.sessionId,
        provider: s.provider.id,
        title: s.provider.history.provisional(s.title, s.cwd) ? (s.firstPrompt ?? s.title) : s.title,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        lastModified: s.lastModified,
        owner: null,
        state: 'stopped',
      });
    }

    for (const l of this.externals()) {
      const entry = byId.get(l.sessionId) ?? {
        sessionId: l.sessionId,
        provider: l.provider.id,
        title: l.name && !l.provider.history.provisional(l.name, l.cwd) ? l.name : '(sem título)',
        cwd: l.cwd,
        lastModified: l.startedAt,
        owner: null,
        state: 'stopped' as const,
      };
      entry.owner = 'pc';
      entry.state = l.status === 'busy' ? 'running' : l.status;
      entry.waitingFor = l.waitingFor;
      entry.pcKind = l.kind;
      entry.pcVia = l.via;
      entry.pcTakeover = l.takeover;
      byId.set(l.sessionId, entry);
    }

    // As do painel sem conversa salva ainda: o título delas é só o rótulo do processo.
    const unsaved = new Set<string>();
    // Sessões do painel por último: o processo do painel também pode aparecer entre as do terminal.
    for (const s of this.sessions.values()) {
      if (!byId.has(s.id)) unsaved.add(s.id);
      const entry = byId.get(s.id) ?? {
        sessionId: s.id,
        provider: s.provider.id,
        title: s.label ?? '(nova sessão)',
        cwd: s.cwd,
        lastModified: s.startedAt,
        owner: null,
        state: 'stopped' as const,
      };
      // Até o agente gerar o título, o rótulo do painel (ou o início do prompt) descreve melhor.
      if (s.label && (entry.title === '(sem título)' || s.provider.history.provisional(entry.title, entry.cwd))) entry.title = s.label;
      entry.owner = 'panel';
      entry.state = s.state === 'starting' ? 'running' : s.state === 'exited' ? 'stopped' : s.state;
      entry.agents = s.state === 'exited' ? undefined : s.activeAgents || undefined;
      entry.thinking = s.thinking || undefined;
      const tasks = s.state === 'exited' ? [] : s.tasks.filter((t) => t.type !== 'local_agent');
      entry.tasks = tasks.length ? tasks.map((t) => ({ type: t.type, description: t.description })) : undefined;
      // Turno encerrado com subagentes em segundo plano: a sessão ainda está trabalhando.
      if (entry.state === 'idle' && entry.agents) entry.state = 'running';
      entry.waitingFor = s.waitingFor;
      entry.pcKind = undefined;
      entry.pcVia = undefined;
      entry.pcTakeover = undefined;
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
        // "/clear"; antes dela, sairia o rótulo do processo (o primeiro pedido de lá), e a lista e a aba
        // trocavam de nome no meio do /clear. Até ela ter um de verdade, fica o da conversa de onde ela veio.
        const before = titles.get(look);
        const provisional = unsaved.has(entry.sessionId) || /^\/[\w:-]+\s*$/.test(entry.title);
        if (provisional && before && !before.startsWith('/')) entry.title = before;
      }
      const name = this.meta.nameOf(entry.sessionId);
      if (name) entry.claudinhoName = name;
      const team = this.meta.teamOf(entry.sessionId);
      if (team) entry.team = team;
      const queue = this.queues.view(entry.sessionId);
      if (queue) {
        entry.queue = queue.items;
        if (queue.paused) entry.queuePaused = true;
      }
      const wsId = this.meta.workspaceOf(entry.sessionId);
      const ws = wsId ? this.workspaces.find(wsId) : undefined;
      if (ws) entry.workspace = tagOf(ws);
      const fork = this.meta.forkOf(entry.sessionId);
      if (fork) entry.forkedFrom = { sessionId: fork.from, title: byId.get(fork.from)?.title };
      const wt = entry.cwd ? worktreeOf(entry.cwd) : null;
      if (wt) entry.worktree = worktreeTag(wt, this.meta.worktreeInfo(wt.path));
    }
    return [...byId.values()].sort((a, b) => b.lastModified - a.lastModified);
  }

  /** O id de onde vem o claudinho da conversa, para o aviso de id novo levar junto. */
  lookOf(sessionId: string): string | undefined {
    return this.meta.lookOf(sessionId);
  }

  /** As mensagens que a bifurcação herdou: as da origem até o ponto do corte, inclusive. */
  private async inherited(provider: AgentProvider, fork: Fork): Promise<SavedMessage[]> {
    const origin = await provider.history.messages(fork.from);
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
    // Conversa que nenhum agente conhece (ainda): o histórico dela é vazio, como sempre foi.
    const provider = await this.providerOf(sessionId).catch(() => this.providers.default());
    const version = await this.historyVersion(provider, sessionId, Boolean(open), fork);
    const hit = this.historyCache.get(key);
    this.historyCache.delete(key);
    if (hit?.version === version) {
      // Reinserida no fim: a mais recente é a última a sair.
      this.historyCache.set(key, hit);
      return hit.events;
    }
    const events = this.readHistory(provider, sessionId, limit, open?.priorMessages, fork);
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
   * (a chave leva o `runId`). Fechada ou no PC, vale enquanto o agente disser que o histórico é o
   * mesmo. Numa bifurcação contam também os da origem, de onde ela tira o histórico até ter turno próprio.
   */
  private async historyVersion(provider: AgentProvider, sessionId: string, open: boolean, fork?: Fork): Promise<string> {
    if (open && !fork) return '';
    const versions = await Promise.all([sessionId, ...(fork ? [fork.from] : [])].map((id) => provider.history.version(id)));
    return versions.join('|');
  }

  /** Lê o histórico salvo e converte em eventos; as imagens achadas vão para o cache de imagens. */
  private async readHistory(provider: AgentProvider, sessionId: string, limit: number, prior?: number, fork?: Fork): Promise<LoggedEvent[]> {
    let messages = await provider.history.messages(sessionId);
    // Bifurcação sem turno próprio: o agente pode só gravar o log dela na primeira mensagem, então
    // até lá o que se mostra é o histórico herdado da origem, cortado no ponto da bifurcação. Vem
    // do meta, e não da sessão viva, para continuar valendo depois que ela é fechada.
    if (messages.length === 0 && fork) messages = await this.inherited(provider, fork);
    else if (prior !== undefined) messages = messages.slice(0, prior);
    const events = messages.slice(-limit).flatMap((m) =>
      m.events(imageStore.sink(sessionId, m.uuid)).map((e) =>
        // Cada mensagem sua leva por onde, de que máquina e quando saiu.
        e.kind === 'user' ? { ...e, uuid: m.uuid, time: m.time, sent: this.origins.sentOf(m.uuid, m.prompt) } : { ...e, uuid: m.uuid, time: m.time },
      ),
    );
    // Histórico salvo não tem seq; numerado localmente só para o cliente ordenar.
    return events.map((e, i) => ({ ...e, seq: i + 1, ts: 0 }) as LoggedEvent);
  }

  /** O histórico salvo de uma conversa, entrada por entrada (os avisos do PC leem o último turno). */
  async savedMessages(sessionId: string): Promise<SavedMessage[]> {
    return (await this.providerOf(sessionId)).history.messages(sessionId);
  }

  /** O que um subagente fez, do histórico salvo dele (agentes do histórico e de conversas abertas no PC). */
  async subagent(sessionId: string, toolUseId: string, agentId?: string): Promise<LoggedEvent[]> {
    return (await this.providerOf(sessionId)).history.subagent(sessionId, toolUseId, agentId);
  }

  /**
   * Diretórios candidatos para sessões novas: subpastas das raízes, as pastas que você adicionou (as
   * que ainda existem) e cwds de conversas salvas dentro delas.
   */
  async projects(): Promise<string[]> {
    // Conversa num worktree conta para o projeto dele, não como projeto à parte.
    const fromSessions = (await this.saved()).flatMap((s) => (s.cwd ? [worktreeOf(s.cwd)?.project ?? s.cwd] : []));
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

  /**
   * Conversa nova. Com `worktree`, ela abre num worktree criado agora a partir do projeto (ver
   * worktrees.ts), para não disputar os arquivos com as outras conversas dele.
   */
  async create(
    opts: RunOptions & {
      /** O agente da conversa; sem ele, o padrão. */
      provider?: string;
      cwd?: string;
      prompt: string;
      title?: string;
      attachments?: Attachment[];
      teamId?: string;
      workspaceId?: string;
      worktree?: boolean;
      from?: Device;
    },
  ): Promise<PanelSession> {
    const { prompt, attachments, teamId, workspaceId, worktree, from, provider: providerId, ...rest } = opts;
    const provider = this.providers.pick(providerId);
    // O time vai copiado: editá-lo depois não muda esta conversa.
    const team = teamId ? snapshotOf(this.teams.get(teamId)) : undefined;
    const ws = workspaceId ? this.workspaces.get(workspaceId) : undefined;
    // Sem projeto: a sessão abre na pasta pessoal (no workspace, no projeto principal dele).
    let cwd = resolve(opts.cwd || ws?.projects[0] || homedir());
    if (!this.isAllowedCwd(cwd)) throw new HttpError(403, 'cwd_outside_roots', { roots: PROJECT_ROOTS });
    const info = await stat(cwd).catch(() => null);
    if (!info?.isDirectory()) throw new HttpError(400, 'cwd_not_a_directory');
    // Instalação que falhou não impede a conversa: o Claude fica sabendo no primeiro turno.
    let notice: string | undefined;
    if (worktree) {
      if (cwd === homedir()) throw new HttpError(400, 'worktree_needs_project');
      const made = await createWorktree(cwd, opts.title || prompt, (dir) => this.isProjectDir(dir));
      await this.meta.setWorktree(made.ref.path, made.info);
      cwd = made.cwd;
      if (made.install && !made.install.ok) {
        notice = `(Aviso do edit.r: o \`${made.install.tool}\` não conseguiu instalar as dependências neste worktree. Instale antes de rodar build ou testes.)\n${made.install.error}`;
      }
    }
    const workspace = ws ? ((await this.workspaces.context(ws.id, cwd)) ?? undefined) : undefined;
    const session = this.adopt(
      new PanelSession({
        ...rest,
        provider,
        cwd,
        team,
        workspace,
        worktree: this.worktreeContext(cwd),
        habilidades: await this.habilidadesPlugin(cwd),
        mcp: this.editrMcp(cwd),
        memory: this.memoryHook,
        label: opts.title || prompt.slice(0, 80),
      }),
    );
    if (team) await this.meta.setTeam(session.id, team);
    if (ws) await this.meta.setWorkspace(session.id, ws.id);
    await this.send(session.id, prompt, { attachments, notice, from });
    return session;
  }

  /** O que a sessão num worktree leva: o aviso para o Claude e de onde vêm as configurações do projeto. */
  private worktreeContext(cwd: string): PanelSessionOptions['worktree'] {
    const ref = worktreeOf(cwd);
    return ref ? { prompt: worktreePrompt(ref, this.meta.worktreeInfo(ref.path)), configRoot: ref.project } : undefined;
  }

  /** O worktree de um projeto conhecido; erro se a pasta não for um. */
  private async worktreeAt(cwd: string) {
    const ref = worktreeOf(await this.knownCwd(cwd));
    if (!ref) throw new HttpError(400, 'not_a_worktree');
    return { ref, info: this.meta.worktreeInfo(ref.path) };
  }

  async worktreeStatus(cwd: string): Promise<WorktreeStatus> {
    const { ref, info } = await this.worktreeAt(cwd);
    return worktreeStatus(ref, info);
  }

  /** Traz os commits do worktree para a branch de origem, no checkout principal. */
  async mergeWorktree(cwd: string): Promise<{ commits: number }> {
    const { ref, info } = await this.worktreeAt(cwd);
    return mergeWorktree(ref, info);
  }

  /**
   * Remove o worktree. As conversas do painel que estavam nele são fechadas (precisam estar paradas); aberta
   * no PC, recusa. Com commits que a base não tem ou mudanças sem commit, só com `force`.
   */
  async removeWorktree(cwd: string, force: boolean): Promise<void> {
    const { ref, info } = await this.worktreeAt(cwd);
    await this.dropWorktree(ref, info, force);
  }

  /**
   * Os worktrees de todos os projetos (os do seletor de projeto), por repositório, para a seção
   * Worktrees do painel Computador. Só os repositórios que têm algum. `usable`: dentro das pastas de
   * projetos, onde dá para abrir conversa e terminal.
   */
  async allWorktrees(): Promise<{ root: string; worktrees: (ListedWorktree & { usable: boolean })[] }[]> {
    // Um projeto, os worktrees dele e as subpastas dão no mesmo repositório: cada um é lido uma vez só.
    const roots = new Set((await Promise.all((await this.projects()).map(repoRootOf))).filter((r): r is string => r !== null));
    const groups = await Promise.all(
      [...roots].map(async (root) => {
        const { worktrees } = await listWorktrees(root, (p) => this.meta.worktreeInfo(p)).catch(() => ({ worktrees: [] as ListedWorktree[] }));
        return { root, worktrees: worktrees.map((w) => ({ ...w, usable: !w.missing && this.isAllowedCwd(w.path) })) };
      }),
    );
    return groups.filter((g) => g.worktrees.length > 0).sort((a, b) => a.root.localeCompare(b.root));
  }

  /** Remove um worktree da lista do projeto, venha ele de onde vier; a pasta que já sumiu só sai do registro. */
  async removeListedWorktree(cwd: string, path: string, force: boolean): Promise<void> {
    const dir = await this.knownCwd(cwd);
    const { ref, missing } = await listedWorktree(dir, path);
    if (missing) {
      await pruneWorktrees(ref.root);
      await this.meta.setWorktree(ref.path, undefined);
      return;
    }
    await this.dropWorktree(ref, this.meta.worktreeInfo(ref.path), force);
  }

  /** O "Trazer" de um worktree da lista do projeto. */
  async mergeListedWorktree(cwd: string, path: string): Promise<{ commits: number }> {
    const { ref, missing } = await listedWorktree(await this.knownCwd(cwd), path);
    if (missing) throw new HttpError(410, 'worktree_removed');
    return mergeWorktree(ref, this.meta.worktreeInfo(ref.path));
  }

  private async dropWorktree(ref: WorktreeRef, info: WorktreeInfo | undefined, force: boolean): Promise<void> {
    const status = await worktreeStatus(ref, info);
    if (!force && unsaved(status)) throw new HttpError(409, 'worktree_unsaved', { changed: status.changed, ahead: status.ahead });
    const inside = (dir?: string) => dir !== undefined && (dir === ref.path || dir.startsWith(ref.path + sep));
    await this.refreshExternals();
    // O processo do painel também aparece entre as do terminal: esse o painel fecha sozinho.
    if (this.externals().some((l) => inside(l.cwd) && !this.sessions.has(l.sessionId))) throw new HttpError(409, 'live_on_pc');
    const own = [...this.sessions.values()].filter((s) => inside(s.cwd) && s.state !== 'exited');
    const busy = own.find((s) => s.state === 'running' || s.state === 'waiting' || s.activeAgents);
    if (busy) throw new HttpError(409, 'session_busy', { state: busy.state, agents: busy.activeAgents });
    await Promise.all(own.map((s) => s.shutdown()));
    await removeWorktree(ref, status, info);
    await this.meta.setWorktree(ref.path, undefined);
    this.emit('catalog');
  }

  /**
   * O que acompanha uma mensagem para o Claude sem aparecer no chat: o conteúdo dos `TODO:n` que ela
   * menciona (ver todos.ts). Posto pelo index.ts, que tem a lista.
   */
  todoContext?: (cwd: string, text: string) => Promise<string | null>;

  /** A memória que o Claude ia gravar vira sugestão (ver memory-suggestions.ts). Posto pelo index.ts, que tem a lista. */
  suggestMemory?: (sessionId: string, tool: string, input: unknown) => Promise<string | null>;
  private readonly memoryHook = (sessionId: string, tool: string, input: unknown) => this.suggestMemory?.(sessionId, tool, input) ?? Promise.resolve(null);

  /** O MCP do edit.r para uma conversa do painel (ver editr-mcp.ts). Posto pelo index.ts, que tem o TODO. */
  mcpFor?: (ctx: EditrMcpContext) => McpServerSpec;

  /** O MCP de uma conversa que vai abrir em `cwd`, amarrado a ela para o `usar_time`. */
  private editrMcp(cwd: string): PanelSessionOptions['mcp'] {
    const build = this.mcpFor;
    return build && ((session) => build({ cwd, useTeam: (teamId) => this.useTeamLater(session, teamId), sessionId: () => session.id }));
  }

  /**
   * O time pedido pelo Claude no meio do turno: trocar agora derrubaria o processo que está rodando a
   * ferramenta, então ele entra quando a conversa para (sem subagente nem tarefa em segundo plano),
   * pelo mesmo caminho do seletor de time.
   */
  private useTeamLater(session: PanelSession, teamId: string): void {
    this.teamLater.set(session, teamId);
    this.applyTeamLater(session);
  }

  private applyTeamLater(session: PanelSession): void {
    const teamId = this.teamLater.get(session);
    if (teamId === undefined || session.state !== 'idle' || session.pendingWork) return;
    this.teamLater.delete(session);
    this.changeTeam(session.id, teamId).catch((err: unknown) => console.warn(`[edit.r] o time ${teamId} não entrou na conversa ${session.id}:`, err));
  }

  /**
   * `notice`: um aviso do edit.r para o Claude, junto do contexto dos TODOs (fora da tela também).
   * `from`: o aparelho que mandou, guardado junto da mensagem (ver origins.ts).
   */
  async send(
    sessionId: string,
    text: string,
    {
      attachments,
      clientId,
      notice,
      from,
      next,
      model,
      effort,
    }: { attachments?: Attachment[]; clientId?: string; notice?: string; from?: Device; next?: boolean; model?: string; effort?: string } = {},
  ): Promise<{ queued?: string }> {
    // Reenvio da fila do celular cuja resposta se perdeu no caminho: já foi entregue, não repete o turno.
    if (clientId && this.delivered.has(clientId)) return {};
    const session = this.get(sessionId);
    // `next`: com o Claude trabalhando (ou a fila ainda saindo), a mensagem espera a vez, com o modelo e o
    // esforço de agora. Parado, ela vai direto, e a fila pausada volta a andar depois dela.
    const queue = this.queues.get(session.id);
    const busy = session.state !== 'idle' || session.pendingWork || this.dispatching.has(session.id) || Boolean(queue?.items.length && !queue.paused);
    if (next && busy) {
      const item = this.queues.add(session.id, { id: clientId, text, attachments: attachments ?? [], model, effort, from });
      if (clientId) this.remember(clientId);
      this.emit('catalog');
      return { queued: item.id };
    }
    if (this.queues.setPaused(session.id, false)) this.emit('catalog');
    // A caixa mostra com que modelo e esforço a próxima mensagem vai, e eles podem ter sido escolhidos com o
    // Claude trabalhando (sem mudar a conversa): valem agora, antes dela.
    if (next) await this.applySettings(session, model, effort);
    await this.deliver(session, text, { attachments, clientId, notice, from });
    return {};
  }

  /** Troca o modelo e o esforço da conversa para os de uma mensagem, só o que for diferente. */
  private async applySettings(session: PanelSession, model?: string, effort?: string): Promise<void> {
    if (model && model !== session.settings.model) await session.setModel(model);
    if (effort && effort !== session.settings.effort) await session.setEffort(effort);
  }

  /** `clientId` das últimas mensagens aceitas, para o reenvio de uma delas não repetir o turno. */
  private remember(clientId: string): void {
    this.delivered.add(clientId);
    if (this.delivered.size > DELIVERED_MAX) this.delivered.delete(this.delivered.values().next().value!);
  }

  private async deliver(
    session: PanelSession,
    text: string,
    { attachments, clientId, notice, from }: { attachments?: Attachment[]; clientId?: string; notice?: string; from?: Device },
  ): Promise<void> {
    if (clientId) this.remember(clientId);
    try {
      const turn = await prepareTurn(session.id, text, attachments, imageStore.sink(session.id, `u${Date.now()}`));
      const todos = await this.todoContext?.(session.cwd, text).catch(() => null);
      const context = [todos, notice].filter(Boolean).join('\n\n') || undefined;
      const at = Date.now();
      const sent = { via: 'editr' as const, device: from?.name, mobile: from?.mobile, at };
      const uuid = session.send(turn.text, { blocks: turn.blocks, images: turn.images, clientId, context, sent });
      this.origins.record({ uuid, at, device: from?.name, mobile: from?.mobile });
    } catch (err) {
      if (clientId) this.delivered.delete(clientId);
      throw err;
    }
  }

  // ---- a fila de mensagens (ver message-queue.ts) ----

  /** Manda agora uma mensagem da fila, com o modelo e o esforço dela, mesmo com o Claude no meio do turno. */
  async sendQueued(sessionId: string, id: string): Promise<void> {
    const session = this.get(sessionId);
    const item = this.queues.take(session.id, id);
    if (!item) throw new HttpError(404, 'not_queued');
    this.queues.setPaused(session.id, false);
    this.emit('catalog');
    await this.deliverQueued(session, item, 0);
  }

  /** Tira uma mensagem da fila e a devolve inteira: para editar na caixa, ou para o desfazer de quem a tirou. */
  takeQueued(sessionId: string, id: string): QueuedMessage {
    const item = this.queues.take(sessionId, id);
    if (!item) throw new HttpError(404, 'not_queued');
    this.emit('catalog');
    return item;
  }

  /**
   * Abrir uma mensagem da fila na caixa: `open` passa a ficar segura (não sai no fim do turno) e volta
   * inteira; `null` fecha. `save`: a que estava aberta, com o que mudou nela, gravada antes, no lugar
   * dela (se ela tiver saído da fila nesse meio-tempo, volta no fim, para a edição não se perder).
   */
  editQueued(
    sessionId: string,
    open: string | null,
    save?: Pick<QueuedMessage, 'id' | 'text' | 'attachments' | 'model' | 'effort'>,
  ): Omit<QueuedMessage, 'from'> | undefined {
    if (save && !this.queues.update(sessionId, save.id, save)) this.queues.add(sessionId, save);
    const message = open ? this.queues.get(sessionId)?.items.find((i) => i.id === open) : undefined;
    if (open && !message) {
      this.queues.hold(sessionId, null);
      this.emit('catalog');
      throw new HttpError(404, 'not_queued');
    }
    this.queues.hold(sessionId, open);
    this.emit('catalog');
    // Solta: se a conversa está parada, a fila segue.
    const session = this.sessions.get(sessionId);
    if (!open && session) setTimeout(() => this.dispatch(session), 0);
    if (!message) return undefined;
    const { from: _from, ...rest } = message;
    return rest;
  }

  /** Põe de volta uma mensagem tirada da fila (o desfazer), no lugar `index`. */
  restoreQueued(sessionId: string, item: Omit<QueuedMessage, 'from'>, index: number): void {
    this.queues.add(sessionId, item, index);
    this.emit('catalog');
  }

  orderQueue(sessionId: string, ids: string[]): void {
    this.queues.order(sessionId, ids);
    this.emit('catalog');
  }

  /** Parar o turno pausa a fila: quem parou costuma querer rever o que vem antes de seguir. */
  async interrupt(sessionId: string): Promise<void> {
    const session = this.get(sessionId);
    if (this.queues.setPaused(session.id, true)) this.emit('catalog');
    await session.interrupt();
  }

  /** O turno acabou e a conversa está parada: a próxima da fila vai, se ela está andando. */
  private dispatch(session: PanelSession): void {
    if (session.state !== 'idle' || session.pendingWork || this.dispatching.has(session.id) || this.restarting.has(session.id)) return;
    if (this.sessions.get(session.id) !== session) return;
    const item = this.queues.next(session.id);
    if (!item) return;
    this.dispatching.add(session.id);
    this.emit('catalog');
    this.deliverQueued(session, item, 0)
      .catch((err: unknown) => console.warn(`[edit.r] a mensagem da fila não foi para a conversa ${session.id}:`, err))
      .finally(() => this.dispatching.delete(session.id));
  }

  /**
   * Manda uma mensagem que estava na fila: antes, o modelo e o esforço dela. Se não der, ela volta para o
   * lugar `index` e a fila pausa, para não tentar de novo sem fim.
   */
  private async deliverQueued(session: PanelSession, item: QueuedMessage, index: number): Promise<void> {
    try {
      await this.applySettings(session, item.model, item.effort);
      await this.deliver(session, item.text, { attachments: item.attachments, clientId: item.id, from: item.from });
    } catch (err) {
      this.queues.add(session.id, item, index);
      this.queues.setPaused(session.id, true);
      this.emit('catalog');
      throw err;
    }
  }

  /**
   * Comandos e skills para o autocompletar do "/", por projeto. As habilidades do edit.r entram como
   * `editr:nome`, tiradas daqui e não do agente (a sonda não leva o plugin), sem as desligadas na
   * conversa `sessionId`. Os do agente vêm do agente da conversa, do pedido, ou do padrão.
   */
  async commands(cwd: string, sessionId?: string, providerId?: string): Promise<CommandInfo[]> {
    const dir = await this.knownCwd(cwd);
    const provider = sessionId ? await this.providerOf(sessionId).catch(() => this.providers.pick(providerId)) : this.providers.pick(providerId);
    const ours = this.habilidadesFor(dir, sessionId).map((h) => ({ name: `editr:${h.name}`, description: h.description, argumentHint: '', builtin: false }));
    const theirs = (await provider.commands(dir)).filter((c) => !c.name.startsWith('editr:'));
    return [...ours, ...theirs];
  }

  /** Modelos e níveis de esforço do agente pedido (ou do padrão). */
  models(providerId?: string): Promise<ModelOption[]> {
    return this.providers.pick(providerId).models();
  }

  /** O agente ligado que tem limites de plano (o padrão, se tiver). */
  private usageProvider(): AgentProvider | undefined {
    const def = this.providers.default();
    return def.usage ? def : this.providers.enabled().find((p) => p.usage);
  }

  /** Limites do plano, do agente que tem. */
  async planUsage(): Promise<PlanUsage> {
    const provider = this.usageProvider();
    if (!provider?.usage) throw new HttpError(404, 'no_plan_usage');
    return provider.usage();
  }

  /** Consultar o uso do plano agora sobe um processo só para isso. */
  planNeedsProbe(): boolean {
    return this.usageProvider()?.usageIsCostly?.() ?? true;
  }

  /** O agente que escreve respostas avulsas (a mensagem do commit): o padrão, se souber. */
  completer(): AgentProvider {
    const def = this.providers.default();
    return def.complete ? def : (this.providers.enabled().find((p) => p.complete) ?? def);
  }

  /** Algo mudou por fora (uma skill ligada, um MCP para a lixeira): os agentes esquecem o que guardaram. */
  forgetSetup(): void {
    for (const p of this.providers.all()) p.forget?.();
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
    const provider = await this.providerOf(sessionId);
    if (!own) {
      await this.refreshExternals();
      if (this.external(sessionId)) throw new HttpError(409, 'live_on_pc');
    }
    await own?.shutdown();
    await provider.history.delete(sessionId);
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

  /** Título gravado no próprio agente (no Claude Code, aparece também no /resume do terminal). */
  async rename(sessionId: string, title: string): Promise<void> {
    await (await this.providerOf(sessionId)).history.rename(sessionId, title.trim());
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
      reload = this.providerOf(sessionId)
        .then((provider) => this.readHistory(provider, sessionId, 5_000, open?.priorMessages, this.meta.forkOf(sessionId)))
        .catch(() => [])
        .finally(() => this.imageReloads.delete(sessionId));
      this.imageReloads.set(sessionId, reload);
    }
    return reload;
  }

  async updateSettings(sessionId: string, patch: { model?: string; effort?: string; permissionMode?: string }): Promise<void> {
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

    const provider = await this.providerOf(sessionId);
    if (opts.fork && !provider.features.fork) throw new HttpError(409, 'fork_unsupported');
    const cwd = await provider.history.cwd(sessionId);
    if (!cwd) throw new HttpError(404, 'session_not_found');
    // O worktree dela foi removido (ou a pasta sumiu): o histórico continua legível, mas não há onde rodar.
    if (!(await isDirectory(cwd))) throw new HttpError(410, worktreeOf(cwd) ? 'worktree_removed' : 'cwd_gone');

    if (!opts.fork) {
      await provider.external?.refresh();
      const live = provider.external?.get(sessionId);
      if (live) {
        throw new HttpError(409, 'live_on_pc', { status: live.status, waitingFor: live.waitingFor, kind: live.kind });
      }
    }
    const uuids = await provider.history.uuids(sessionId);
    // Bifurcar no meio: o corte fica no último registro que fica de pé, e o resto é descartado.
    const cut = opts.at ? uuids.indexOf(opts.at) : -1;
    if (opts.at && cut < 0) throw new HttpError(404, 'fork_point_not_found');
    const priorMessages = cut >= 0 ? cut + 1 : uuids.length;
    const session = this.adopt(
      new PanelSession({
        ...opts,
        provider,
        cwd,
        resume: sessionId,
        resumeAt: opts.at,
        priorMessages,
        origin: opts.fork ? sessionId : undefined,
        // Retomada (ou bifurcada) com o time que ela tinha e o contexto atual do workspace dela.
        team: this.meta.teamOf(sessionId),
        workspace: await this.workspaceContext(sessionId, cwd),
        worktree: this.worktreeContext(cwd),
        // Retomada (ou bifurcada), com as habilidades que estavam desligadas nela.
        habilidades: await this.habilidadesPlugin(cwd, sessionId),
        mcp: this.editrMcp(cwd),
        memory: this.memoryHook,
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
   * Troca (ou tira, com `null`) o time de uma conversa que já começou. O agente fixa os subagentes quando o
   * processo sobe: aberta no painel, ela precisa estar parada, e o processo é encerrado e retomado com
   * o time novo, com os mesmos modelo, esforço e modo. Fechada (ou no PC), o time vale quando ela for
   * aberta no painel.
   */
  async changeTeam(sessionId: string, teamId: string | null): Promise<void> {
    const team = teamId ? snapshotOf(this.teams.get(teamId)) : undefined;
    await this.restartWith(sessionId, () => this.meta.setTeam(sessionId, team));
  }

  /**
   * Troca (ou tira, com `null`) o workspace de uma conversa que já começou. Como o time, o contexto dele
   * entra quando o processo sobe: aberta no painel, ela precisa estar parada e é retomada com o novo.
   */
  async changeWorkspace(sessionId: string, workspaceId: string | null): Promise<void> {
    if (workspaceId) this.workspaces.get(workspaceId);
    await this.restartWith(sessionId, () => this.meta.setWorkspace(sessionId, workspaceId ?? undefined));
  }

  /** Grava a mudança com o processo da conversa (se aberta no painel) encerrado, e a retoma com os mesmos ajustes. */
  private async restartWith(sessionId: string, change: () => Promise<void>): Promise<void> {
    const own = this.sessions.get(sessionId);
    this.restarting.add(sessionId);
    try {
      if (own) await own.release();
      await change();
      if (own) {
        const { model, effort, permissionMode } = own.settings;
        await this.open(sessionId, { model, effort: effort ?? undefined, permissionMode });
      }
    } finally {
      this.restarting.delete(sessionId);
    }
    this.emit('catalog');
  }

  /** O contexto do workspace da conversa, montado do workspace como ele está agora. */
  private async workspaceContext(sessionId: string, cwd: string): Promise<{ prompt: string; directories: string[] } | undefined> {
    const wsId = this.meta.workspaceOf(sessionId);
    return wsId ? ((await this.workspaces.context(wsId, cwd)) ?? undefined) : undefined;
  }

  /**
   * Retoma a conversa no painel para mandar uma mensagem daqui; aberta e ociosa no terminal do PC, ela
   * é encerrada lá antes. Não há botão para isso: quem chama é a fila de mensagens do app quando a
   * conversa não está aberta no painel (ver web/src/lib/outbox.ts), e cada mensagem mostra de onde saiu.
   */
  async takeOver(sessionId: string, opts: RunOptions = {}): Promise<PanelSession> {
    const own = this.sessions.get(sessionId);
    if (own) return own;

    await this.refreshExternals();
    const live = this.external(sessionId);
    if (live?.provider.external) {
      await live.provider.external.close(live);
      await live.provider.external.refresh();
      if (live.provider.external.get(sessionId)) throw new HttpError(409, 'still_live_on_pc');
    }
    return this.open(sessionId, opts);
  }

  /** Liberar: encerra o processo do painel para a sessão poder ser retomada no terminal. */
  async release(sessionId: string): Promise<{ resumeCommand: string }> {
    const session = this.get(sessionId);
    await session.release();
    return { resumeCommand: session.provider.resumeCommand(session.cwd, session.id) };
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
        opened.push((await this.open(e.sessionId, { model: e.model, effort: e.effort ?? undefined, permissionMode: e.permissionMode })).id);
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
      this.queues.rekey(from, to);
      const wsId = this.meta.workspaceOf(session.origin ?? from);
      if (wsId) void this.meta.setWorkspace(to, wsId);
      void this.meta.copyHabilidades(session.origin ?? from, to);
      this.emit('rekey', from, to);
      this.emit('catalog');
    });
    session.on('cleared', (from: string, to: string) => {
      void this.meta.setCleared(from, to);
      this.queues.rekey(from, to);
      this.emit('catalog');
    });
    session.on('event', (ev: LoggedEvent) => {
      // Turno interrompido ou com erro: a fila espera você.
      if (ev.kind === 'result' && !ev.ok && this.queues.setPaused(session.id, true)) this.emit('catalog');
      this.emit('event', session.id, ev, session.runId);
    });
    session.on('delta', (text: string) => this.emit('delta', session.id, text));
    session.on('state', () => {
      this.emit('catalog');
      this.applyTeamLater(session);
      // Depois do resto do fim do turno (o resultado pode chegar logo atrás do estado e pausar a fila).
      if (session.state === 'idle') setTimeout(() => this.dispatch(session), 0);
    });
    // Processo novo de uma conversa com fila andando (o time ou o workspace trocou no fim do turno): ela segue.
    setTimeout(() => this.dispatch(session), 0);
    session.on('exit', () => {
      this.teamLater.delete(session);
      // O processo caiu (ou foi fechado) com mensagens esperando: elas esperam você, como depois de parar.
      // Na troca de time ou de workspace, não: o processo novo sobe e a fila segue.
      if (!this.restarting.has(session.id)) this.queues.setPaused(session.id, true);
      if (session.habilidades) void removePlugin(session.habilidades);
      this.sessions.delete(session.id);
      this.savedCache = undefined;
      this.emit('catalog');
    });
    this.emit('catalog');
    return session;
  }

  /** Conversas salvas de todos os agentes ligados, com cache curto; quem pede enquanto a leitura anda espera a mesma. */
  private saved(): Promise<SavedRow[]> {
    const hit = this.savedCache;
    if (hit && (hit.at === undefined || Date.now() - hit.at < SAVED_CACHE_MS)) return hit.rows;
    const rows = Promise.all(
      this.providers.enabled().map(async (provider) => (await provider.history.list()).map((s) => ({ ...s, provider }))),
    ).then((lists) => lists.flat());
    const entry: SavedCache = { rows };
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
