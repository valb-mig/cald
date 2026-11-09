import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR, MACHINE_NAME } from './config.ts';
import {
  Ctx,
  KINDS,
  readContent,
  REPO_DIR,
  safeRel,
  writeContent,
  type Entry,
  type Incoming,
  type Kind,
  type KindId,
  type RepoIndex,
  type SyncDeps,
  type Unit,
} from './config-sync-kinds.ts';
import { HttpError } from './errors.ts';
import { git, gitWrite, remoteWebUrl } from './git.ts';

/**
 * A sua configuração do cald num repositório git seu (no GitHub, privado), para levar de uma máquina
 * a outra: times, workspaces, habilidades, detalhes e TODOs, comandos salvos, a memória do Claude, o
 * que é seu no Claude Code e a aparência do app (ver config-sync-kinds.ts). "Enviar" grava o daqui
 * num clone em DATA_DIR e dá push; "Trazer" baixa e aplica aqui.
 *
 * Cada item tem um id que não muda entre máquinas e a data da última edição, guardados no cald.json
 * do repositório: fica sempre o mais novo, nos dois sentidos. Nada é apagado, nem aqui nem lá: o que
 * você apagou numa máquina continua no repositório, e esta máquina lembra o que já viu (`known`)
 * para não trazer de volta o que você apagou aqui. O que um "Trazer" troca fica copiado antes.
 */

const exec = promisify(execFile);

const STATE_FILE = process.env.CONFIG_SYNC_FILE ?? join(DATA_DIR, 'config-sync.json');
const INDEX_FILE = 'cald.json';
const APPEARANCE_FILE = 'aparencia.json';
// Quantos nomes cada lista do relatório leva; o resto vai só na conta.
const MAX_LABELS = 200;

export type Direction = 'push' | 'pull';
/** As preferências do app no navegador (chave do localStorage → valor), que só o app lê e aplica. */
export type Appearance = Record<string, string>;
/**
 * Por que um item ficou como estava: `newer-there`, o do outro lado é mais novo; `newer-here`, o
 * daqui é; `deleted-here`, você o apagou aqui depois de ele passar por esta máquina; `no-project`,
 * o projeto dele não existe aqui; `rejected`, não passou na validação (ou tem o nome de outro).
 */
export type SkipReason = 'newer-there' | 'newer-here' | 'deleted-here' | 'no-project' | 'rejected';
export type KindReport = { kind: KindId; added: string[]; updated: string[]; same: number; skipped: { label: string; reason: SkipReason }[]; total: number; totalAdded: number };
export type SyncReport = {
  direction: Direction;
  dry: boolean;
  kinds: KindReport[];
  /** Projetos do repositório que não existem nesta máquina. */
  missingProjects: string[];
  /** O commit do envio; `null` sem nada novo para enviar. */
  commit: string | null;
  /** Ao trazer: a aparência de lá, quando é diferente da deste aparelho. */
  appearance: Appearance | null;
};
export type SyncStatus = {
  repo: string | null;
  url: string | null;
  machine: string;
  lastPush: number | null;
  lastPull: number | null;
  /** O último envio que o clone conhece, de qualquer máquina. */
  remote: { machine: string; at: number } | null;
};

type State = {
  /** `dono/nome` no GitHub, ou o endereço git. */
  repo: string | null;
  url: string | null;
  /** `tipo:id` → a data do item da última vez que ele passou por aqui (enviado ou trazido). */
  known: Record<string, number>;
  lastPush?: number;
  lastPull?: number;
};

const README = `# Configuração do cald

Este repositório guarda a sua configuração do [cald](https://github.com/valb-mig/cald): times, workspaces, habilidades, detalhes e TODOs dos projetos, comandos salvos, a memória do Claude e o que é seu no Claude Code (settings, CLAUDE.md, agentes e skills).

Quem escreve aqui é o próprio cald, em **Computador → Sincronizar**: "Enviar" grava o de uma máquina, e "Trazer" aplica o daqui em outra. Dá para ler e editar à mão, mas o que o cald segue é o \`cald.json\`: quando cada item mudou (fica sempre o mais novo) e de que projeto ele é.

- \`times/\`, \`workspaces/\`, \`habilidades/\`, \`comandos/\`: o que vale em todo projeto.
- \`projetos/<nome>/\`: detalhes, TODOs, habilidades, comandos e memória de um projeto. Em outra máquina, o projeto é achado pelo remoto do git (ou pelo caminho).
- \`claude/\`: o que é seu no Claude Code (\`~/.claude\`). Caminhos da pasta pessoal viram \`{{HOME}}\`.
- \`aparencia.json\`: tema, fundo e preferências do app.

Segredos não vêm para cá: nada de PIN, chaves das notificações, credenciais do Claude Code ou variáveis de ambiente com cara de senha (\`*_TOKEN\`, \`*_KEY\`…) do settings.json.
`;

/** O `gh` deste PC, com o login dele; o erro dele vai para a tela como está. */
async function gh(args: string[]): Promise<string> {
  try {
    return (await exec('gh', args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') throw new HttpError(422, 'no_gh');
    const stderr = String(e.stderr ?? '');
    if (/gh auth login|not logged/i.test(stderr)) throw new HttpError(422, 'gh_auth');
    throw new HttpError(422, 'config_repo_failed', { message: stderr.trim().split('\n').slice(-3).join('\n') || e.message });
  }
}

const exists = (abs: string) => stat(abs).then(
  () => true,
  () => false,
);

async function readIndex(): Promise<RepoIndex> {
  try {
    const data = JSON.parse(await readFile(join(REPO_DIR, INDEX_FILE), 'utf8')) as Partial<RepoIndex>;
    if (data.format === 1) {
      // Um caminho que sairia do clone (cald.json editado à mão) não vale.
      const items = Object.fromEntries(Object.entries(data.items ?? {}).filter(([, e]) => e && safeRel(e.path) && typeof e.updatedAt === 'number'));
      return { format: 1, items, projects: data.projects ?? {}, lastPush: data.lastPush };
    }
  } catch {
    // Repositório novo, sem índice.
  }
  return { format: 1, items: {}, projects: {} };
}

// Chaves em ordem: o diff de um envio para o outro mostra só o que mudou.
const sorted = <T>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).sort(([a], [b]) => a.localeCompare(b)));

async function writeIndex(index: RepoIndex): Promise<void> {
  const data = { ...index, items: sorted(index.items), projects: sorted(index.projects) };
  await writeFile(join(REPO_DIR, INDEX_FILE), `${JSON.stringify(data, null, 2)}\n`);
}

/** O caminho preferido, ou com `-2`, `-3` antes da extensão se outro item já está lá. */
function freePath(preferred: string, taken: Set<string>): string {
  const dot = preferred.lastIndexOf('.');
  const ext = dot > preferred.lastIndexOf('/') ? preferred.slice(dot) : '';
  const stem = preferred.slice(0, preferred.length - ext.length);
  let path = preferred;
  for (let n = 2; taken.has(path); n++) path = `${stem}-${n}${ext}`;
  return path;
}

/** `atual` é `preferido` ou `preferido-N`: o item continua no mesmo arquivo. */
function samePlace(current: string, preferred: string): boolean {
  const dot = preferred.lastIndexOf('.');
  const ext = dot > preferred.lastIndexOf('/') ? preferred.slice(dot) : '';
  const stem = preferred.slice(0, preferred.length - ext.length);
  return current === preferred || new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+${ext.replace('.', '\\.')}$`).test(current);
}

/** Conta o item e, até MAX_LABELS, guarda o nome dele na lista. */
function listed(r: KindReport, list: 'added' | 'updated', label: string): void {
  r.total++;
  if (list === 'added') r.totalAdded++;
  if (r[list].length < MAX_LABELS) r[list].push(label);
}

/** Mesmas chaves e valores, em qualquer ordem. */
function sameAppearance(a: Appearance, b: Appearance): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

export class ConfigSync {
  private state: State = { repo: null, url: null, known: {} };
  private busy = false;
  private writing = Promise.resolve();
  private readonly deps: SyncDeps;

  constructor(deps: SyncDeps) {
    this.deps = deps;
  }

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(STATE_FILE, 'utf8')) as Partial<State>;
      this.state = { repo: data.repo ?? null, url: data.url ?? null, known: data.known ?? {}, lastPush: data.lastPush, lastPull: data.lastPull };
    } catch {
      // Primeiro uso: sem repositório.
    }
  }

  async status(): Promise<SyncStatus> {
    const index = this.state.repo ? await readIndex() : null;
    return {
      repo: this.state.repo,
      url: this.state.url,
      machine: MACHINE_NAME,
      lastPush: this.state.lastPush ?? null,
      lastPull: this.state.lastPull ?? null,
      remote: index?.lastPush ?? null,
    };
  }

  /**
   * Liga a um repositório: `dono/nome` (ou só `nome`, na sua conta) no GitHub, pelo `gh`, ou um
   * endereço git qualquer. Com `create`, cria o repositório, privado. Um público é recusado: a
   * memória e os TODOs são seus.
   */
  connect(input: string, create: boolean): Promise<SyncStatus> {
    return this.exclusive(async () => {
      const spec = input.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
      let repo: string;
      let url: string | null;
      const fresh = async () => {
        await rm(REPO_DIR, { recursive: true, force: true });
        await mkdir(dirname(REPO_DIR), { recursive: true });
      };
      if (/^[\w.-]+(?:\/[\w.-]+)?$/.test(spec)) {
        const name = spec.includes('/') ? spec : `${(await gh(['api', 'user', '--jq', '.login'])).trim()}/${spec}`;
        if (create) await gh(['repo', 'create', name, '--private', '--description', 'Configuração do cald, sincronizada pelo app.']);
        const info = JSON.parse(await gh(['repo', 'view', name, '--json', 'nameWithOwner,url,visibility'])) as { nameWithOwner: string; url: string; visibility: string };
        if (info.visibility === 'PUBLIC') throw new HttpError(409, 'config_repo_public', { repo: info.nameWithOwner });
        await fresh();
        await gh(['repo', 'clone', info.nameWithOwner, REPO_DIR, '--', '--quiet']);
        repo = info.nameWithOwner;
        url = info.url;
      } else if (/^(?:[\w+.-]+:\/\/|[\w.-]+@[\w.-]+:|\/)/.test(input.trim())) {
        if (create) throw new HttpError(400, 'config_repo_create_github');
        await fresh();
        await gitWrite(dirname(REPO_DIR), ['clone', '--quiet', input.trim(), REPO_DIR]);
        repo = input.trim();
        url = remoteWebUrl(repo);
      } else {
        throw new HttpError(400, 'invalid_config_repo');
      }
      // Outro repositório: o que esta máquina já viu do anterior não vale para ele.
      const changed = repo !== this.state.repo;
      this.state = { repo, url, known: changed ? {} : this.state.known, lastPush: changed ? undefined : this.state.lastPush, lastPull: changed ? undefined : this.state.lastPull };
      await this.save();
      return this.status();
    });
  }

  /** Esquece o repositório (ele fica no GitHub como está) e apaga o clone. */
  disconnect(): Promise<SyncStatus> {
    return this.exclusive(async () => {
      await rm(REPO_DIR, { recursive: true, force: true });
      this.state = { repo: null, url: null, known: {} };
      await this.save();
      return this.status();
    });
  }

  /**
   * Envia ou traz as categorias pedidas; `dry` só diz o que aconteceria (a prévia). `appearance`: a
   * aparência deste aparelho, que o app manda (para enviar, ou para comparar com a de lá ao trazer).
   */
  run(direction: Direction, kinds: KindId[], appearance: Appearance | undefined, dry: boolean): Promise<SyncReport> {
    return this.exclusive(async () => {
      try {
        return await this.sync(direction, new Set(kinds), appearance, dry);
      } catch (err) {
        // Outra máquina enviou no meio: refaz o envio por cima do que ela mandou, uma vez.
        if (!(err instanceof HttpError) || !/rejected|fetch first|non-fast-forward/i.test(String(err.details?.message))) throw err;
        return this.sync(direction, new Set(kinds), appearance, dry);
      }
    });
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new HttpError(409, 'config_sync_busy');
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  private async sync(direction: Direction, wanted: Set<string>, appearance: Appearance | undefined, dry: boolean): Promise<SyncReport> {
    await this.prepare();
    const index = await readIndex();
    const ctx = new Ctx(this.deps, index, direction, dry);
    const report: SyncReport = { direction, dry, kinds: [], missingProjects: [], commit: null, appearance: null };
    const missing = new Set<string>();

    for (const kind of KINDS) {
      if (!wanted.has(kind.id)) continue;
      const r: KindReport = { kind: kind.id, added: [], updated: [], same: 0, skipped: [], total: 0, totalAdded: 0 };
      report.kinds.push(r);
      const units = await kind.units(ctx);
      if (direction === 'push') await this.pushKind(ctx, kind, units, r);
      else await this.pullKind(ctx, kind, units, r, missing);
      const after = direction === 'push' ? kind.afterPush : kind.afterPull;
      for (const label of (await after?.(ctx)) ?? []) listed(r, 'updated', label);
    }

    if (wanted.has('appearance')) report.kinds.push(await this.appearance(direction, appearance, dry, report));
    report.missingProjects = [...missing].sort();

    const changed = report.kinds.some((k) => k.total > 0);
    if (direction === 'push' && !dry && changed) {
      index.lastPush = { machine: MACHINE_NAME, at: Date.now() };
      await writeIndex(index);
      if (!(await exists(join(REPO_DIR, 'README.md')))) await writeFile(join(REPO_DIR, 'README.md'), README);
      report.commit = await this.commitAndPush(report);
    }
    if (!dry) {
      if (direction === 'push') this.state.lastPush = Date.now();
      else this.state.lastPull = Date.now();
      await this.save();
    }
    return report;
  }

  /** Grava no clone o que é mais novo aqui; o mais novo de lá fica, e aparece no relatório. */
  private async pushKind(ctx: Ctx, kind: Kind, units: Unit[], r: KindReport): Promise<void> {
    const { index } = ctx;
    const taken = new Set(Object.values(index.items).map((e) => e.path));
    for (const u of units) {
      const key = `${kind.id}:${u.id}`;
      const old = index.items[key];
      if (old && old.updatedAt > u.updatedAt) {
        r.skipped.push({ label: u.label, reason: 'newer-there' });
        continue;
      }
      if (old && old.updatedAt === u.updatedAt) {
        r.same++;
        if (!ctx.dry) this.state.known[key] = u.updatedAt;
        continue;
      }
      const path = old && samePlace(old.path, u.path) ? old.path : freePath(u.path, taken);
      if (!ctx.dry) {
        // Mudou de nome: o arquivo antigo sai, para o item não ficar em dois lugares.
        if (old && old.path !== path) await rm(join(REPO_DIR, old.path), { recursive: true, force: true });
        await writeContent(join(REPO_DIR, path), await u.read());
        this.state.known[key] = u.updatedAt;
      }
      taken.add(path);
      index.items[key] = { path, label: u.label, updatedAt: u.updatedAt, machine: MACHINE_NAME, project: u.project };
      listed(r, old ? 'updated' : 'added', u.label);
    }
  }

  /** Aplica aqui o que é mais novo lá, menos o que você apagou aqui e o que é de projeto que não existe aqui. */
  private async pullKind(ctx: Ctx, kind: Kind, units: Unit[], r: KindReport, missing: Set<string>): Promise<void> {
    const local = new Map(units.map((u) => [u.id, u]));
    const incoming: Incoming[] = [];
    const prefix = `${kind.id}:`;
    for (const [key, entry] of Object.entries(ctx.index.items) as [string, Entry][]) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      const mine = local.get(id);
      if (mine && mine.updatedAt >= entry.updatedAt) {
        if (mine.updatedAt === entry.updatedAt) r.same++;
        else r.skipped.push({ label: entry.label, reason: 'newer-here' });
        if (!ctx.dry && mine.updatedAt === entry.updatedAt) this.state.known[key] = entry.updatedAt;
        continue;
      }
      const seen = this.state.known[key];
      if (!mine && seen !== undefined && entry.updatedAt <= seen) {
        r.skipped.push({ label: entry.label, reason: 'deleted-here' });
        continue;
      }
      let project: string | undefined;
      if (entry.project) {
        project = (await ctx.pathOf(entry.project)) ?? undefined;
        if (!project) {
          r.skipped.push({ label: entry.label, reason: 'no-project' });
          missing.add(ctx.index.projects[entry.project]?.name ?? entry.project);
          continue;
        }
      }
      // Na prévia não precisa do conteúdo: só a conta.
      const content = ctx.dry ? new Map() : await readContent(join(REPO_DIR, entry.path));
      if (!content) {
        r.skipped.push({ label: entry.label, reason: 'rejected' });
        continue;
      }
      incoming.push({ id, entry, project, content });
    }
    if (!ctx.dry && incoming.length) await ctx.backupStores();
    const rejected = new Set(ctx.dry || !incoming.length ? [] : await kind.apply(ctx, incoming));
    for (const i of incoming) {
      const key = `${prefix}${i.id}`;
      if (rejected.has(i.id)) {
        r.skipped.push({ label: i.entry.label, reason: 'rejected' });
        continue;
      }
      listed(r, local.has(i.id) ? 'updated' : 'added', i.entry.label);
      if (!ctx.dry) this.state.known[key] = i.entry.updatedAt;
    }
  }

  /**
   * A aparência não tem data: ao enviar, a deste aparelho vai se for diferente da de lá; ao trazer,
   * a de lá volta para o app aplicar, se for diferente da deste aparelho.
   */
  private async appearance(direction: Direction, mine: Appearance | undefined, dry: boolean, report: SyncReport): Promise<KindReport> {
    const r: KindReport = { kind: 'appearance', added: [], updated: [], same: 0, skipped: [], total: 0, totalAdded: 0 };
    const file = join(REPO_DIR, APPEARANCE_FILE);
    const there = await readFile(file, 'utf8')
      .then((t) => (JSON.parse(t) as { values?: Appearance }).values ?? null)
      .catch(() => null);
    const label = 'Tema, fundo e preferências do app';
    if (direction === 'push') {
      if (!mine || !Object.keys(mine).length) return r;
      if (there && sameAppearance(there, mine)) r.same++;
      else {
        if (!dry) await writeFile(file, `${JSON.stringify({ machine: MACHINE_NAME, at: Date.now(), values: sorted(mine) }, null, 2)}\n`);
        listed(r, there ? 'updated' : 'added', label);
      }
    } else if (there) {
      if (mine && sameAppearance(there, mine)) r.same++;
      else {
        report.appearance = there;
        listed(r, 'updated', label);
      }
    }
    return r;
  }

  /** O clone em dia com o remoto, sem nada de envios que pararam no meio (o que não subiu volta a sair daqui). */
  private async prepare(): Promise<void> {
    const { repo } = this.state;
    if (!repo) throw new HttpError(409, 'config_repo_missing');
    if (!(await exists(join(REPO_DIR, '.git')))) {
      await mkdir(dirname(REPO_DIR), { recursive: true });
      if (/^[\w.-]+\/[\w.-]+$/.test(repo)) await gh(['repo', 'clone', repo, REPO_DIR, '--', '--quiet']);
      else await gitWrite(dirname(REPO_DIR), ['clone', '--quiet', repo, REPO_DIR]);
    }
    await gitWrite(REPO_DIR, ['fetch', '--quiet', '--prune', 'origin']);
    const branch = await this.branch();
    const remote = await git(REPO_DIR, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).then(
      () => true,
      () => false,
    );
    if (remote) await gitWrite(REPO_DIR, ['reset', '--quiet', '--hard', `origin/${branch}`]);
    else await gitWrite(REPO_DIR, ['reset', '--quiet', '--hard']).catch(() => undefined);
    await gitWrite(REPO_DIR, ['clean', '-fdq']);
  }

  /** O ramo do clone (num repositório vazio, o que o primeiro commit vai criar). */
  private async branch(): Promise<string> {
    return (await git(REPO_DIR, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  }

  private async commitAndPush(report: SyncReport): Promise<string | null> {
    await gitWrite(REPO_DIR, ['add', '-A']);
    if (!(await git(REPO_DIR, ['status', '--porcelain'])).stdout.trim()) return null;
    const n = report.kinds.reduce((sum, k) => sum + k.total, 0);
    const lines = report.kinds.filter((k) => k.total).map((k) => `- ${k.kind}: ${k.total}`);
    // Sem nome no git desta máquina, o commit sai como o cald dela.
    const named = await git(REPO_DIR, ['config', 'user.email']).then(
      (r) => r.stdout.trim() !== '',
      () => false,
    );
    const ident = named ? [] : ['-c', 'user.name=cald', '-c', `user.email=cald@${MACHINE_NAME}`];
    await gitWrite(REPO_DIR, [...ident, 'commit', '--quiet', '-m', `cald: ${MACHINE_NAME} enviou ${n} ${n === 1 ? 'item' : 'itens'}`, '-m', lines.join('\n')]);
    await gitWrite(REPO_DIR, ['push', '--quiet', '-u', 'origin', 'HEAD']);
    return (await git(REPO_DIR, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
  }

  // Gravação atômica e em fila, como nos stores.
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(STATE_FILE), { recursive: true });
      await writeFile(`${STATE_FILE}.tmp`, snapshot);
      await rename(`${STATE_FILE}.tmp`, STATE_FILE);
    });
    return this.writing;
  }
}
