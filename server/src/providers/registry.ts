import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { HttpError } from '../errors.ts';
import type { AgentProvider, AgentProviderInfo } from './types.ts';

/** Quais agentes estão ligados e qual abre as conversas novas; `updatedAt`, quando você mudou por último. */
export type AgentPrefs = { enabled: Record<string, boolean>; default?: string; updatedAt?: number };
type Prefs = AgentPrefs;

const FILE = process.env.AGENTS_FILE ?? join(STATE_DIR, 'agents.json');

/**
 * Os agentes que o cald conhece (ver providers/types.ts) e o que você escolheu na seção Agentes do
 * painel Computador. Desligado, um agente sai de tudo: não abre conversa, as conversas dele saem da
 * lista e as abertas no terminal deixam de ser acompanhadas. Sempre fica pelo menos um ligado, e o
 * padrão é um dos ligados. O primeiro da lista (o Claude Code) nasce ligado; os outros, desligados.
 * Avisa `change` quando algo muda, com o agente que ligou ou desligou.
 */
export class ProviderRegistry extends EventEmitter {
  private readonly providers: AgentProvider[];
  private prefs: Prefs = { enabled: {} };
  private writing = Promise.resolve();

  constructor(providers: AgentProvider[]) {
    super();
    if (!providers.length) throw new Error('nenhum agente registrado');
    this.providers = providers;
  }

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(FILE, 'utf8')) as Partial<Prefs>;
      const enabled = data.enabled && typeof data.enabled === 'object' ? data.enabled : {};
      this.prefs = {
        enabled,
        default: typeof data.default === 'string' ? data.default : undefined,
        updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : undefined,
      };
    } catch {
      // Primeiro uso ou arquivo ilegível: vale o padrão.
    }
  }

  all(): AgentProvider[] {
    return this.providers;
  }

  isEnabled(id: string): boolean {
    return this.prefs.enabled[id] ?? id === this.providers[0]!.id;
  }

  enabled(): AgentProvider[] {
    const on = this.providers.filter((p) => this.isEnabled(p.id));
    // Um arquivo editado à mão que desliga todos não deixa o cald sem agente.
    return on.length ? on : [this.providers[0]!];
  }

  /** Um agente ligado, pelo id; erro se não existe ou está desligado. */
  get(id: string): AgentProvider {
    const provider = this.providers.find((p) => p.id === id);
    if (!provider) throw new HttpError(404, 'unknown_agent');
    if (!this.enabled().includes(provider)) throw new HttpError(409, 'agent_disabled');
    return provider;
  }

  /** O agente das conversas novas. */
  default(): AgentProvider {
    const on = this.enabled();
    return on.find((p) => p.id === this.prefs.default) ?? on[0]!;
  }

  /** O pedido, ou o padrão sem pedido. */
  pick(id?: string): AgentProvider {
    return id ? this.get(id) : this.default();
  }

  async info(): Promise<AgentProviderInfo[]> {
    const fallback = this.default().id;
    return Promise.all(
      this.providers.map(async (p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        features: p.features,
        ...(await p.status().catch((err: unknown) => ({ available: false, problem: err instanceof Error ? err.message : String(err) }))),
        enabled: this.enabled().includes(p),
        default: p.id === fallback,
      })),
    );
  }

  /** Liga, desliga ou torna padrão. Ligar ou tornar padrão um agente que não está pronto é recusado. */
  async set(id: string, change: { enabled?: boolean; default?: boolean }): Promise<void> {
    const provider = this.providers.find((p) => p.id === id);
    if (!provider) throw new HttpError(404, 'unknown_agent');
    const turningOn = change.enabled === true || change.default === true;
    if (turningOn && !(await provider.status().catch(() => ({ available: false }))).available) throw new HttpError(409, 'agent_unavailable');

    const was = this.isEnabled(id);
    const enabled = { ...this.prefs.enabled };
    if (change.enabled !== undefined) enabled[id] = change.enabled;
    if (change.default) enabled[id] = true;
    if (!this.providers.some((p) => enabled[p.id] ?? p.id === this.providers[0]!.id)) throw new HttpError(409, 'last_agent');

    let fallback = this.prefs.default;
    if (change.default) fallback = id;
    // O padrão desligado passa para o primeiro que ficou ligado.
    else if (change.enabled === false && this.default().id === id) fallback = undefined;
    this.prefs = { enabled, default: fallback, updatedAt: Date.now() };
    await this.save();
    this.emit('change', was !== this.isEnabled(id) ? provider : undefined);
  }

  /** O que você escolheu, para levar a outra máquina (ver config-sync.ts). */
  prefsSnapshot(): AgentPrefs {
    return this.prefs;
  }

  /**
   * O que veio de outra máquina: liga só os agentes que existem e estão prontos aqui, e sempre fica
   * ao menos um ligado (o que valer pelas regras de `enabled` e `default`).
   */
  async adopt(prefs: AgentPrefs): Promise<void> {
    const enabled: Record<string, boolean> = {};
    for (const p of this.providers) {
      const wanted = prefs.enabled?.[p.id];
      if (wanted === undefined) continue;
      if (wanted && !(await p.status().catch(() => ({ available: false }))).available) continue;
      enabled[p.id] = wanted;
    }
    if (!this.providers.some((p) => enabled[p.id] ?? p.id === this.providers[0]!.id)) enabled[this.providers[0]!.id] = true;
    const fallback = prefs.default && (enabled[prefs.default] ?? prefs.default === this.providers[0]!.id) ? prefs.default : undefined;
    this.prefs = { enabled, default: fallback, updatedAt: prefs.updatedAt ?? Date.now() };
    await this.save();
    this.emit('change');
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.prefs, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(FILE), { recursive: true });
      await writeFile(`${FILE}.tmp`, snapshot);
      await rename(`${FILE}.tmp`, FILE);
    });
    return this.writing;
  }
}
