import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { query, type SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { HttpError } from '../../errors.ts';
import type { PlanUsage } from '../../system.ts';
import type { AgentProvider, CommandInfo, ModelOption, ProviderStatus, RunHost, RunOptions } from '../types.ts';
import { CLAUDE_BIN, childEnv } from './env.ts';
import { claudeHistory } from './history.ts';
import { hiddenSessions, LiveRegistry } from './live.ts';
import { listClaudeTrash, type ClaudeTrashed } from './manage.ts';
import { withProbe } from './probe.ts';
import { ClaudeRun } from './run.ts';
import { describeSetup, probeSetup, type ClaudeSetup } from './setup.ts';
import { readPlanUsage } from './usage.ts';

const exec = promisify(execFile);

const CACHE_MS = 10 * 60_000;

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

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * O Claude Code como agente do cald (ver providers/types.ts), pelo Agent SDK e pelo que ele guarda em
 * ~/.claude. O que dá para perguntar a uma conversa aberta (modelos, comandos, uso do plano, skills e
 * MCPs) vai para ela; sem nenhuma aberta na pasta, sobe uma sonda, e o resultado fica guardado por 10 min.
 */
export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude';
  readonly name = 'Claude Code';
  readonly description = 'O agente de código da Anthropic, com as credenciais e o histórico do seu ~/.claude.';
  readonly features = {
    usage: true,
    memory: true,
    skills: true,
    mcp: true,
    effort: true,
    permissionModes: ['default', 'acceptEdits', 'plan', 'auto'],
    fork: true,
    pcSessions: true,
  };
  readonly history = claudeHistory;
  /** As abertas no terminal e no VSCode, por `claude agents --json`. */
  readonly external = new LiveRegistry();

  private readonly runs = new Set<ClaudeRun>();
  private version?: Promise<ProviderStatus>;
  private modelsCache?: { at: number; list: Promise<ModelOption[]> };
  private readonly commandsCache = new Map<string, { at: number; list: Promise<CommandInfo[]> }>();
  private readonly setupCache = new Map<string, { at: number; setup: Promise<ClaudeSetup> }>();

  /** O binário do SDK responde: a versão dele (perguntada uma vez, ela só muda com o cald). */
  status(): Promise<ProviderStatus> {
    this.version ??= exec(CLAUDE_BIN, ['--version'], { timeout: 10_000, env: childEnv() }).then(
      ({ stdout }) => ({ available: true, version: stdout.trim().split(/\s/)[0] }),
      (err: unknown) => {
        this.version = undefined;
        return { available: false, problem: err instanceof Error ? err.message : String(err) };
      },
    );
    return this.version;
  }

  start(opts: RunOptions, host: RunHost): ClaudeRun {
    const run: ClaudeRun = new ClaudeRun(opts, host, () => this.runs.delete(run));
    this.runs.add(run);
    return run;
  }

  /** Uma conversa aberta no painel nesta pasta (ou em qualquer uma), para perguntar sem subir sonda. */
  private openIn(dir?: string): ClaudeRun | undefined {
    for (const run of this.runs) if (dir === undefined || run.cwd === dir) return run;
    return undefined;
  }

  /** Modelos e níveis de esforço. */
  models(): Promise<ModelOption[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < CACHE_MS) return this.modelsCache.list;
    const open = this.openIn();
    const list = (open ? open.models() : withProbe(homedir(), (q) => q.supportedModels())).then((models) =>
      models.map((m) => ({ value: m.value, resolvedModel: m.resolvedModel, displayName: m.displayName, efforts: m.supportedEffortLevels ?? [] })),
    );
    const entry = { at: Date.now(), list };
    this.modelsCache = entry;
    list.catch(() => {
      if (this.modelsCache === entry) this.modelsCache = undefined;
    });
    return list;
  }

  commands(dir: string): Promise<CommandInfo[]> {
    const open = this.openIn(dir);
    if (open) return open.commands().then(filterCommands);
    const hit = this.commandsCache.get(dir);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
    const list = withProbe(dir, (q) => q.supportedCommands()).then(filterCommands);
    this.commandsCache.set(dir, { at: Date.now(), list });
    list.catch(() => this.commandsCache.delete(dir));
    return list;
  }

  /** Limites do plano: pela conversa aberta no painel, se houver; senão por uma sonda. */
  usage(): Promise<PlanUsage> {
    const open = this.openIn();
    return open ? open.planUsage() : withProbe(homedir(), readPlanUsage);
  }

  /** Sem conversa aberta no painel, consultar o uso do plano sobe um Claude Code inteiro (a sonda). */
  usageIsCostly(): boolean {
    return this.runs.size === 0;
  }

  /**
   * Pede ao Haiku (rápido) uma resposta só. Roda isolado: sem ferramentas, sem as configurações e hooks
   * seus nem o CLAUDE.md (que mudariam o texto), e sem gravar conversa.
   */
  async complete({ cwd, system, prompt, signal }: { cwd: string; system: string; prompt: string; signal: AbortSignal }): Promise<string> {
    const abort = new AbortController();
    signal.addEventListener('abort', () => abort.abort(), { once: true });
    // Fora da lista de conversas vivas: é só uma consulta, não um claudinho novo.
    const sessionId = randomUUID();
    hiddenSessions.add(sessionId);
    const q = query({
      prompt,
      options: {
        cwd,
        env: childEnv(),
        model: 'haiku',
        systemPrompt: system,
        tools: [],
        settingSources: [],
        persistSession: false,
        thinking: { type: 'disabled' },
        maxTurns: 1,
        abortController: abort,
        sessionId,
      },
    });
    try {
      for await (const msg of q) {
        if (msg.type !== 'result') continue;
        if (msg.subtype !== 'success') throw new HttpError(502, 'complete_failed');
        return msg.result;
      }
      throw new HttpError(502, 'complete_failed');
    } finally {
      q.close();
      // O processo leva um instante para sair da lista do `claude agents`.
      setTimeout(() => hiddenSessions.delete(sessionId), 60_000);
    }
  }

  resumeCommand(cwd: string, sessionId: string): string {
    return `cd ${shellQuote(cwd)} && claude --resume ${sessionId}`;
  }

  // ---- o que só o Claude tem: skills, agentes e MCPs (a seção Agentes → Claude Code do painel Computador) ----

  /**
   * Skills, agentes e servidores MCP de uma pasta (a pasta pessoal, que vale em todas, quando não é de
   * um projeto): pela conversa do painel aberta ali, se houver; senão por uma sonda. `project`: se a
   * pasta é de um projeto (a lixeira mostra as coisas dele); `projects`: os projetos do painel, para
   * achar onde mais um MCP está.
   */
  async setup(dir: string, project: boolean, projects: () => Promise<string[]>, refresh = false): Promise<ClaudeSetup & { trash: ClaudeTrashed[] }> {
    let hit = this.setupCache.get(dir);
    if (refresh || !hit || Date.now() - hit.at >= CACHE_MS) {
      const open = this.openIn(dir);
      const raw = open ? open.setup() : withProbe(dir, probeSetup);
      const setup = Promise.all([raw, projects()]).then(([r, list]) => describeSetup(dir, r, list));
      hit = { at: Date.now(), setup };
      this.setupCache.set(dir, hit);
      setup.catch(() => this.setupCache.delete(dir));
    }
    // A lixeira vem sempre do disco: ela muda sem o Claude Code saber.
    const [setup, trash] = await Promise.all([hit.setup, listClaudeTrash(project ? dir : undefined)]);
    return { ...setup, trash };
  }

  /**
   * Liga ou desliga um servidor MCP numa pasta. O Claude Code grava isso por pasta (no ~/.claude.json),
   * então vale para as próximas conversas ali; as do painel abertas nela mudam na hora.
   */
  async toggleMcp(dir: string, name: string, enabled: boolean): Promise<void> {
    const open = [...this.runs].filter((r) => r.cwd === dir);
    if (open.length) for (const r of open) await r.toggleMcp(name, enabled);
    else await withProbe(dir, (q) => q.toggleMcpServer(name, enabled));
    this.setupCache.delete(dir);
    this.commandsCache.delete(dir);
  }

  /** Depois de ligar, desligar ou mandar algo para a lixeira: o que vale mudou em todas as pastas. */
  forget(): void {
    this.setupCache.clear();
    this.commandsCache.clear();
  }
}
