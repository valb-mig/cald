import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gitSummaries, remoteWebUrl } from './git.ts';
import { githubInbox, type InboxGithubItem } from './github.ts';
import type { TodoStore } from './todos.ts';

const exec = promisify(execFile);

/**
 * A inbox: tudo o que pede você, de todos os projetos desta máquina e do GitHub da conta. PRs e issues
 * (ver `githubInbox`), projetos com mudança sem commit, commits sem push ou atrás do remoto, e os TODOs
 * a fazer. As conversas que esperam você o app junta por conta própria, do catálogo, que já é ao vivo.
 *
 * Cada item tem uma chave, que não muda, e uma marca, que muda quando ele muda (um commit novo no PR,
 * mais arquivos alterados): o "visto" guarda a marca de quando foi visto, e o item volta como novo se
 * ela mudar. Visto e adiado ficam em `inbox.json`, no PC principal (ver `InboxState`).
 */

export type InboxItem =
  | ({ type: 'github'; key: string; mark: string; cwd?: string } & InboxGithubItem)
  | { type: 'git'; key: string; mark: string; cwd: string; branch: string | null; changed: number; ahead: number; behind: number }
  | { type: 'todo'; key: string; mark: string; cwd: string; n: number; title: string; createdAt: number };

export type Inbox = {
  items: InboxItem[];
  /** Sem dar para buscar no GitHub (sem `gh`, sem login, cota…), o motivo; a inbox segue com o resto. */
  github: { ok: true } | { ok: false; reason: string; message?: string };
};

const REMOTE_TTL_MS = 10 * 60_000;
const remotes = new Map<string, { at: number; url: Promise<string | null> }>();

/** O endereço no GitHub (ou outro) do remoto do projeto, para ligar a ele os PRs e issues do repositório. */
function remoteOf(cwd: string): Promise<string | null> {
  const hit = remotes.get(cwd);
  if (hit && Date.now() - hit.at < REMOTE_TTL_MS) return hit.url;
  const url = exec('git', ['config', '--get', 'remote.origin.url'], { cwd, timeout: 5_000 }).then(
    ({ stdout }) => remoteWebUrl(stdout),
    () => null,
  );
  remotes.set(cwd, { at: Date.now(), url });
  return url;
}

export async function buildInbox(projects: string[], todos: TodoStore, refresh: boolean): Promise<Inbox> {
  const [gh, git, urls] = await Promise.all([
    githubInbox(refresh),
    gitSummaries(projects, refresh),
    Promise.all(projects.map(async (cwd) => [((await remoteOf(cwd)) ?? '').toLowerCase(), cwd] as const)),
  ]);
  const byRepo = new Map(urls.filter(([url]) => url));
  const items: InboxItem[] = [];
  if (gh.ok) {
    for (const g of gh.items) {
      items.push({ type: 'github', key: `gh:${g.url}`, mark: `${g.reason}|${g.updatedAt}`, cwd: byRepo.get(g.repoUrl.toLowerCase()), ...g });
    }
  }
  for (const [cwd, s] of Object.entries(git)) {
    if (!s.changed && !s.ahead && !s.behind) continue;
    items.push({ type: 'git', key: `git:${cwd}`, mark: `${s.changed}|${s.ahead}|${s.behind}`, cwd, branch: s.branch, changed: s.changed, ahead: s.ahead, behind: s.behind });
  }
  for (const { cwd, todo } of todos.open()) {
    items.push({ type: 'todo', key: `todo:${cwd}:${todo.n}`, mark: `${todo.updatedAt ?? todo.createdAt}`, cwd, n: todo.n, title: todo.title, createdAt: todo.createdAt });
  }
  return { items, github: gh.ok ? { ok: true } : { ok: false, reason: gh.reason, message: gh.message } };
}

/** O que você fez com um item: viu (com a marca de então) ou adiou até tal hora. */
export type ItemState = { seen?: string; snoozedUntil?: number; at: number };
export type StateAction = { key: string; action: 'seen' | 'snooze' | 'clear'; mark?: string; until?: number };

const FILE = process.env.INBOX_FILE ?? join(homedir(), '.local', 'share', 'claude-remote', 'inbox.json');
const MAX_KEYS = 2_000;

export class InboxState {
  private state: Record<string, ItemState> = {};
  private writing = Promise.resolve();

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(FILE, 'utf8')) as { items?: Record<string, ItemState> };
      this.state = data.items && typeof data.items === 'object' ? data.items : {};
    } catch {
      // Primeiro uso ou arquivo ilegível: começa vazio.
    }
  }

  all(): Record<string, ItemState> {
    return this.state;
  }

  async apply(actions: StateAction[]): Promise<Record<string, ItemState>> {
    const next = { ...this.state };
    const now = Date.now();
    for (const a of actions) {
      if (a.action === 'clear') delete next[a.key];
      else if (a.action === 'seen') next[a.key] = { seen: a.mark ?? '', at: now };
      else next[a.key] = { ...next[a.key], snoozedUntil: a.until ?? now + 24 * 3_600_000, at: now };
    }
    // Não cresce sem fim: os mais antigos saem (um item visto há muito tempo que voltar, volta como novo).
    const keys = Object.keys(next);
    if (keys.length > MAX_KEYS) {
      for (const k of keys.sort((a, b) => next[a]!.at - next[b]!.at).slice(0, keys.length - MAX_KEYS)) delete next[k];
    }
    this.state = next;
    const snapshot = JSON.stringify({ items: next }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(FILE), { recursive: true });
      await writeFile(`${FILE}.tmp`, snapshot);
      await rename(`${FILE}.tmp`, FILE);
    });
    await this.writing;
    return this.state;
  }
}
