import { EventEmitter } from 'node:events';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { cpus } from 'node:os';

const SAMPLE_MS = 3_000;
const PLAN_TTL_MS = 90_000;
// Sem conversa aberta no painel, cada consulta sobe um Claude Code inteiro só para isso.
const PLAN_PROBE_TTL_MS = 10 * 60_000;

export type SystemSnapshot = {
  at: number;
  cpu: { percent: number; cores: number; load: [number, number, number] };
  memory: { total: number; used: number; swapTotal: number; swapUsed: number };
  /** Processos do Claude Code (terminal, VSCode e painel) e a memória residente somada. */
  claude: { processes: number; rss: number };
  uptimeSec: number;
};

export type UsageWindow = { utilization: number | null; resetsAt: string | null };

export type PlanUsage = {
  subscription: string | null;
  /** false: limites do plano não se aplicam (chave de API, Bedrock…). */
  available: boolean;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** Janelas semanais por modelo, quando a conta tem. */
  models: (UsageWindow & { name: string })[];
  extraUsage: { utilization: number | null } | null;
};

export type UsageSnapshot = {
  plan: PlanUsage | null;
  planError?: string;
  planAt?: number;
};

type CpuTimes = { idle: number; total: number };

async function readCpu(): Promise<CpuTimes> {
  const line = (await readFile('/proc/stat', 'utf8')).split('\n', 1)[0]!;
  const n = line.trim().split(/\s+/).slice(1, 9).map(Number);
  return { idle: n[3]! + (n[4] ?? 0), total: n.reduce((a, b) => a + b, 0) };
}

async function readMemory(): Promise<SystemSnapshot['memory']> {
  const text = await readFile('/proc/meminfo', 'utf8');
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0) * 1024;
  const total = kb('MemTotal');
  return {
    total,
    used: total - kb('MemAvailable'),
    swapTotal: kb('SwapTotal'),
    swapUsed: kb('SwapTotal') - kb('SwapFree'),
  };
}

// Binários nativos do Claude Code: /opt/claude-code/bin/claude, o do VSCode e o do Agent SDK.
const CLAUDE_EXE = /\/claude( \(deleted\))?$/;

async function readClaudeProcesses(): Promise<SystemSnapshot['claude']> {
  const pids = (await readdir('/proc')).filter((d) => /^\d+$/.test(d));
  let processes = 0;
  let rss = 0;
  await Promise.all(
    pids.map(async (pid) => {
      try {
        if (!CLAUDE_EXE.test(await readlink(`/proc/${pid}/exe`))) return;
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        processes++;
        rss += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
      } catch {
        // Processo que terminou no meio da leitura ou de outro usuário.
      }
    }),
  );
  return { processes, rss };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

/**
 * Amostra o PC e o uso do Claude só enquanto há alguém com o painel aberto;
 * sem clientes conectados, nada roda.
 */
export class SystemMonitor extends EventEmitter {
  system: SystemSnapshot | null = null;
  usage: UsageSnapshot = { plan: null };

  private clients = 0;
  private timer?: NodeJS.Timeout;
  private prevCpu?: CpuTimes;
  private planBusy = false;
  private readonly fetchPlan: () => Promise<PlanUsage>;
  private readonly planNeedsProbe: () => boolean;

  constructor(fetchPlan: () => Promise<PlanUsage>, planNeedsProbe: () => boolean) {
    super();
    this.fetchPlan = fetchPlan;
    this.planNeedsProbe = planNeedsProbe;
  }

  addClient(): void {
    if (this.clients++ > 0) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), SAMPLE_MS);
  }

  removeClient(): void {
    if (--this.clients > 0) return;
    this.clients = 0;
    clearInterval(this.timer);
    this.prevCpu = undefined;
  }

  private async tick(): Promise<void> {
    try {
      const [cpu, memory, claude, loadavg, uptime] = await Promise.all([
        readCpu(),
        readMemory(),
        readClaudeProcesses(),
        readFile('/proc/loadavg', 'utf8'),
        readFile('/proc/uptime', 'utf8'),
      ]);
      const prev = this.prevCpu;
      this.prevCpu = cpu;
      // A primeira amostra não tem base para calcular a CPU: guarda e espera a próxima.
      if (!prev) return void this.refreshUsageIfStale();
      const busy = 1 - (cpu.idle - prev.idle) / Math.max(1, cpu.total - prev.total);
      const load = loadavg.split(' ').slice(0, 3).map(Number) as [number, number, number];
      this.system = {
        at: Date.now(),
        cpu: { percent: Math.round(busy * 1000) / 10, cores: cpus().length, load },
        memory,
        claude,
        uptimeSec: Math.round(Number(uptime.split(' ')[0])),
      };
      this.emit('system', this.system);
    } catch (err) {
      this.emit('error', err);
    }
    this.refreshUsageIfStale();
  }

  private refreshUsageIfStale(): void {
    const now = Date.now();
    const ttl = this.planNeedsProbe() ? PLAN_PROBE_TTL_MS : PLAN_TTL_MS;
    if (!this.planBusy && now - (this.usage.planAt ?? 0) > ttl) void this.refreshPlan();
  }

  private async refreshPlan(): Promise<void> {
    this.planBusy = true;
    try {
      const plan = await this.fetchPlan();
      this.usage = { ...this.usage, plan, planError: undefined, planAt: Date.now() };
    } catch (err) {
      this.usage = { ...this.usage, planError: errorText(err), planAt: Date.now() };
    } finally {
      this.planBusy = false;
    }
    this.emit('usage', this.usage);
  }

}
