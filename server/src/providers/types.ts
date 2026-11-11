import type { ImageSink } from '../images.ts';
import type { LoggedEvent, PanelEvent, Question, Sent } from '../events.ts';
import type { McpServerSpec } from '../editr-mcp.ts';
import type { PlanUsage } from '../system.ts';
import type { TeamSnapshot } from '../teams.ts';

/**
 * O contrato entre o edit.r e um agente de código (o Claude Code hoje; Codex, Gemini e outros depois).
 *
 * O edit.r cuida do que é dele: o catálogo de conversas, o log de eventos com `seq`, os cartões de
 * aprovação e de pergunta, a fila do celular, a origem de cada mensagem, times, workspaces, worktrees
 * e habilidades. O agente cuida do processo e do formato dele: abre e retoma conversas, traduz o que
 * fala para o vocabulário do painel (`PanelEvent`, em events.ts) e devolve o histórico salvo no mesmo
 * vocabulário. Um agente novo é só mais uma implementação de `AgentProvider`, registrada em index.ts.
 *
 * As ferramentas seguem os nomes do Claude Code (Bash, Read, Edit, Write, Agent, AskUserQuestion,
 * TodoWrite…), que o app já sabe desenhar: o agente que chama as dele de outro jeito
 * traduz para esses quando houver equivalente; as que não têm aparecem como ferramenta genérica.
 */

// ---------------------------------------------------------------------------
// Modelo, comando e ajustes
// ---------------------------------------------------------------------------

/** Um modelo que o agente aceita. `value` é o que se pede; `efforts`, os níveis de esforço dele. */
export type ModelOption = { value: string; resolvedModel?: string; displayName: string; efforts: string[] };

/** Um comando (ou skill) do "/". `builtin`: do próprio agente, não seu nem de plugin. */
export type CommandInfo = { name: string; description: string; argumentHint: string; builtin: boolean };

/** Modelo, esforço e modo de permissão vigentes, com os valores do próprio agente. */
export type RunSettings = { model?: string; effort?: string | null; permissionMode?: string };

/** Ocupação do contexto e o ponto em que a compactação automática começa. */
export type ContextUsage = {
  model: string;
  totalTokens: number;
  maxTokens: number;
  autoCompactThreshold: number | null;
  autoCompactEnabled: boolean;
};

// ---------------------------------------------------------------------------
// Mensagem, aprovação e pergunta
// ---------------------------------------------------------------------------

/** O que vai junto do texto de uma mensagem sua: por ora, imagens (em base64). */
export type TurnBlock = { type: 'image'; mediaType: string; data: string };

/** Uma mensagem sua para o agente. */
export type UserTurn = {
  /** Id da mensagem no histórico do agente, escolhido pelo edit.r: é por ele que se acha depois de onde ela veio. */
  uuid: string;
  text: string;
  /** Imagens, antes do texto. */
  blocks?: TurnBlock[];
  /** Vai depois do texto, à parte: é para o agente, não para a tela (o conteúdo dos TODOs, avisos do edit.r). */
  context?: string;
};

/** O agente pede para usar uma ferramenta. */
export type ApprovalRequest = {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  title?: string;
  decisionReason?: string;
  blockedPath?: string;
  /** O agente sugeriu uma regra: dá para liberar de vez, e não só agora. */
  canAlwaysAllow: boolean;
  /** O agente desistiu do pedido (turno interrompido): o cartão sai. */
  signal: AbortSignal;
};

/** `always`: aplicar a regra que o agente sugeriu. */
export type ApprovalDecision = { allow: true; always?: boolean } | { allow: false; message: string };

/** O agente faz perguntas de múltipla escolha. */
export type QuestionRequest = { questions: Question[]; toolUseId?: string; signal: AbortSignal };

/** `answers`: o texto de cada pergunta → a opção escolhida (várias separadas por vírgula, ou texto livre). */
export type QuestionReply = { answered: true; answers: Record<string, string> } | { answered: false; message: string };

// ---------------------------------------------------------------------------
// Uma conversa rodando
// ---------------------------------------------------------------------------

/** O que o edit.r entrega ao agente para abrir (ou retomar) uma conversa. */
export type RunOptions = {
  cwd: string;
  /** Retomar esta conversa salva. */
  resume?: string;
  /** Com `resume`: a retomada vira uma conversa nova (bifurcação), e a original fica intacta. */
  fork?: boolean;
  /** Com `fork`: a nova leva o histórico só até esta entrada. */
  resumeAt?: string;
  /** Id da conversa nova (ou da bifurcação), escolhido pelo edit.r; o agente que não aceita escolher avisa o dele por `rekey`. */
  sessionId?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  title?: string;
  /** Instruções do edit.r para o fim do prompt de sistema: o time, o workspace, o worktree. */
  instructions?: string;
  /** Pastas que o agente lê sem pedir: os anexos do celular, os outros projetos do workspace. */
  directories: string[];
  /** A pasta é um worktree: de onde vêm as configurações locais do projeto (permissões, hooks). */
  configRoot?: string;
  /** O time da conversa, para virar os subagentes dela. */
  team?: TeamSnapshot;
  /**
   * A pasta com as habilidades do edit.r que valem nesta conversa: `skills/<nome>/SKILL.md` (o formato das
   * Agent Skills), mais o manifesto que faz dela um plugin do Claude Code (ver habilidades.ts).
   */
  skills?: string;
  /** O MCP do edit.r, já amarrado a esta conversa. */
  mcp?: McpServerSpec;
  /**
   * Antes de cada ferramenta que grava arquivo (Write, Edit): um recado para negar e seguir (a memória
   * que vira sugestão, ver memory-suggestions.ts), ou `null` para deixar passar.
   */
  beforeWrite?: (tool: string, input: unknown) => Promise<string | null>;
};

/**
 * O lado do edit.r de uma conversa rodando (ver panel-session.ts): o agente avisa por aqui o que
 * acontece, já no vocabulário do painel, e pede aprovações e respostas.
 */
export interface RunHost {
  /** O id da conversa agora (muda com `rekey`). */
  readonly sessionId: string;
  /** Eventos novos. `uuid`: a entrada do histórico de onde vieram, que é o ponto de corte de uma bifurcação. */
  events(events: PanelEvent[], uuid?: string): void;
  /** Texto parcial da resposta, que só vale até ela chegar inteira. */
  delta(text: string): void;
  /** Onde guardar as imagens que chegam (prints, arquivos lidos), pela entrada do histórico. */
  images(uuid?: string): ImageSink;
  /** O agente mudou de estado por conta própria: começou um turno sozinho, parou, espera você. */
  state(state: 'running' | 'idle' | 'waiting'): void;
  /** O turno acabou. `idle`: o agente não avisa quando para, e o fim do turno faz as vezes disso. */
  turnEnd(idle: boolean): void;
  /** Começou ou acabou a compactação do contexto. */
  compacting(on: boolean): void;
  settings(patch: RunSettings): void;
  /** A conversa tem outro id (o agente só diz no começo, ou recomeçou). */
  rekey(id: string): void;
  /** A conversa recomeçou do zero (o /clear): a tela esvazia e ela segue, talvez com outro id. */
  reset(newId?: string): void;
  approve(request: ApprovalRequest): Promise<ApprovalDecision>;
  ask(request: QuestionRequest): Promise<QuestionReply>;
  /** O processo do agente terminou (com o erro, se foi por um). */
  exit(error?: string): void;
}

/** Uma conversa aberta no agente, dirigida pelo edit.r. */
export interface ProviderRun {
  send(turn: UserTurn): void;
  setModel(model: string): Promise<void>;
  setEffort(effort: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  interrupt(): Promise<void>;
  contextUsage(): Promise<ContextUsage>;
  /** Para uma tarefa em segundo plano deste processo (404 se não é dele). */
  stopTask(taskId: string): Promise<void>;
  /** O fim da saída de uma tarefa em segundo plano, sem gastar um turno. */
  taskOutput(taskId: string): Promise<{ output: string; totalBytes: number }>;
  /** A pasta das habilidades (`skills`) foi refeita: relê sem reiniciar. */
  reloadSkills(): Promise<void>;
  /** Fecha a entrada: o agente termina o que faz e sai, avisando por `exit`. */
  end(): void;
  /** Encerra já, quando `end` não bastou. */
  kill(): void;
}

// ---------------------------------------------------------------------------
// Conversas salvas
// ---------------------------------------------------------------------------

/** Uma conversa salva pelo agente. */
export type SavedSession = {
  sessionId: string;
  /** O título como o agente guarda (o seu, o gerado, ou o começo da primeira mensagem). */
  title: string;
  firstPrompt?: string;
  cwd?: string;
  gitBranch?: string;
  lastModified: number;
};

/** Uma entrada do histórico salvo (pode não render evento nenhum: mesmo assim conta para o corte de uma bifurcação). */
export type SavedMessage = {
  uuid: string;
  /** Os eventos do painel desta entrada, convertidos só quando pedidos; as imagens vão para `sink`. */
  events(sink?: ImageSink): PanelEvent[];
  /** Quando foi gravada, se o agente sabe (o app mostra quanto cada ferramenta levou). */
  time?: number;
  /** Mensagem sua: quando e por onde entrou (terminal, VSCode…), segundo o agente. */
  prompt?: { at: number; via?: Sent['via'] };
};

export interface ProviderHistory {
  list(): Promise<SavedSession[]>;
  /** A pasta de uma conversa salva; `undefined` se ela não existe. */
  cwd(sessionId: string): Promise<string | undefined>;
  /** Os ids das entradas, em ordem: bastam para contar e achar o ponto de uma bifurcação. */
  uuids(sessionId: string): Promise<string[]>;
  messages(sessionId: string): Promise<SavedMessage[]>;
  /** Muda quando o histórico muda (o edit.r guarda o convertido até lá). */
  version(sessionId: string): Promise<string>;
  /** O título é provisório (o agente ainda não gerou um): o começo da primeira mensagem descreve melhor. */
  provisional(title: string, cwd?: string): boolean;
  rename(sessionId: string, title: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
  /** O que um subagente fez, do histórico salvo dele. */
  subagent(sessionId: string, toolUseId: string, agentId?: string): Promise<LoggedEvent[]>;
}

// ---------------------------------------------------------------------------
// Conversas abertas fora do painel (terminal, editor)
// ---------------------------------------------------------------------------

export type ExternalSession = {
  sessionId: string;
  cwd: string;
  kind: 'interactive' | 'background';
  status: 'busy' | 'waiting' | 'idle';
  waitingFor?: string;
  name?: string;
  startedAt: number;
  /** De onde: o terminal, o VSCode, o app do Claude ou outro app (um host do SDK, como outro edit.r). */
  via?: 'terminal' | 'vscode' | 'desktop' | 'app';
  /** Se o painel consegue fechá-la lá para continuar aqui (só a do terminal, ver stopPcSession). */
  takeover?: boolean;
};

/** As conversas do agente abertas no PC, fora do painel. Avisa `change` quando a lista muda. */
export interface ExternalSessions {
  on(event: 'change', listener: () => void): unknown;
  off(event: 'change', listener: () => void): unknown;
  start(): Promise<void>;
  stop(): void;
  refresh(): Promise<void>;
  get(sessionId: string): ExternalSession | undefined;
  all(): ExternalSession[];
  /** Encerra no PC uma conversa ociosa no terminal, para o painel assumir. */
  close(session: ExternalSession): Promise<void>;
}

// ---------------------------------------------------------------------------
// O agente
// ---------------------------------------------------------------------------

/** O que o agente oferece além do básico: liga as abas da página dele no app e os controles do chat. */
export type ProviderFeatures = {
  /** Limites do plano. */
  usage: boolean;
  /** Memória automática por projeto. */
  memory: boolean;
  /** Skills, comandos e subagentes que dá para ver e ligar. */
  skills: boolean;
  /** Servidores MCP que dá para ver e ligar. */
  mcp: boolean;
  /** Níveis de esforço no seletor de modelo. */
  effort: boolean;
  /** Modos de permissão aceitos, na ordem do seletor. */
  permissionModes: string[];
  /** Bifurcar uma conversa. */
  fork: boolean;
  /** Acompanha as conversas abertas no terminal do PC. */
  pcSessions: boolean;
  /** Faz tarefas avulsas no seu jeito (`assist`), como organizar um PR. */
  assist: boolean;
};

export type ProviderStatus = { available: boolean; version?: string; problem?: string };

/** Um agente de código: o strategy que o edit.r usa para conversar com ele. */
export interface AgentProvider {
  /** Curto e estável: vai no catálogo e nas preferências (`claude`). */
  readonly id: string;
  readonly name: string;
  /** Uma linha sobre o que ele é. */
  readonly description: string;
  readonly features: ProviderFeatures;
  /** Está instalado e pronto? A versão, ou por que não. */
  status(): Promise<ProviderStatus>;
  /** Abre (ou retoma) uma conversa. */
  start(opts: RunOptions, host: RunHost): ProviderRun;
  readonly history: ProviderHistory;
  /** Conversas abertas fora do painel, se o agente deixa acompanhar. */
  readonly external?: ExternalSessions;
  models(): Promise<ModelOption[]>;
  /** Comandos do "/" numa pasta. */
  commands(cwd: string): Promise<CommandInfo[]>;
  /** Os limites do plano. */
  usage?(): Promise<PlanUsage>;
  /** Ler o uso agora sobe um processo só para isso (sem conversa aberta para perguntar). */
  usageIsCostly?(): boolean;
  /** Uma resposta avulsa, sem ferramentas, sem as suas configurações e sem conversa salva (a mensagem do commit). */
  complete?(opts: { cwd: string; system: string; prompt: string; signal: AbortSignal }): Promise<string>;
  /**
   * Uma tarefa avulsa no seu jeito: com as suas configurações, o CLAUDE.md e as skills, mas só lendo o
   * projeto (sem comandos, edições nem MCP) e sem gravar conversa. A resposta segue `schema` (organizar um PR).
   */
  assist?(opts: {
    cwd: string;
    task: string;
    prompt: string;
    schema: Record<string, unknown>;
    signal: AbortSignal;
    model?: string;
    effort?: string;
    /** O JSON da resposta até onde já foi escrito, a cada pedaço: a tela mostra enquanto ele escreve. */
    onPartial?: (json: string) => void;
  }): Promise<unknown>;
  /** O comando que continua a conversa no terminal, para o "Liberar". */
  resumeCommand(cwd: string, sessionId: string): string;
  /** Esquecer o que guardou de comandos e configurações (algo mudou por fora). */
  forget?(): void;
}

/** O agente como o app vê, na seção Agentes do painel Computador (GET /api/agents). */
export type AgentProviderInfo = Pick<AgentProvider, 'id' | 'name' | 'description' | 'features'> &
  ProviderStatus & { enabled: boolean; default: boolean };
