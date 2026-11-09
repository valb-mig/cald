import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { HttpError } from './errors.ts';
import { worktreeOf } from './worktrees.ts';

/**
 * Workspaces: um molde de conversa, como uma gem. Juntam projetos (o primeiro é o principal, onde a
 * conversa abre; os outros entram como pastas extras), instruções, regras, comandos de build/teste/lint,
 * arquivos de contexto e um time padrão. A conversa guarda só de qual workspace ela é (ver meta.ts): o
 * contexto é montado do workspace atual sempre que o processo dela sobe, então editar vale a partir da
 * próxima vez que ela for aberta.
 *
 * Cada projeto pode ter um workspace padrão (`defaultFor`), com que a conversa nova dele já vem; na
 * conversa dá para trocar por qualquer outro que tenha o projeto, ou ficar sem.
 */

export type WorkspaceFile = { id: string; name: string; mediaType: string; size: number };
/** Um comando do projeto (build, teste, lint…), para o Claude e o time saberem como validar. */
export type WorkspaceCommand = { label: string; command: string; cwd?: string };

export type Workspace = {
  id: string;
  name: string;
  /** Índice da cor da paleta do app: o chip da conversa e a placa da salinha. */
  color: number;
  projects: string[];
  instructions: string;
  rules: string[];
  commands: WorkspaceCommand[];
  teamId?: string;
  files: WorkspaceFile[];
  /** Os projetos de que este é o workspace padrão (um projeto tem no máximo um). */
  defaultFor: string[];
  updatedAt: number;
};

export type WorkspaceInput = Omit<Workspace, 'id' | 'files' | 'defaultFor' | 'updatedAt'> & { id?: string };
/** O que a lista de conversas e a salinha mostram do workspace de uma conversa. */
export type WorkspaceTag = Pick<Workspace, 'id' | 'name' | 'color'>;

export const MAX_INSTRUCTIONS = 20_000;
export const MAX_RULES = 40;
export const MAX_COMMANDS = 30;
export const MAX_PROJECTS = 12;
export const MAX_FILES = 30;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
// Arquivos de texto pequenos vão inteiros no prompt de sistema, até este total; o resto vai por caminho.
const INLINE_BUDGET = 30 * 1024;
const TEXT = /^text\/|json|xml|yaml|toml|javascript|typescript|markdown|csv/;
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.ts', '.tsx', '.js', '.py', '.sql', '.html', '.css', '.env.example']);

// Dado seu, como os TODOs e os times: fica com os dados do app, não no cache.
const FILE = process.env.WORKSPACES_FILE ?? join(DATA_DIR, 'workspaces.json');
const FILES_DIR = join(dirname(FILE), 'workspace-files');

function safeName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^\.+/, '');
  return cleaned.slice(-120) || 'arquivo';
}

const unique = (list: string[]) => [...new Set(list.map((s) => s.trim()).filter(Boolean))];

/** Avisa `change` a cada gravação, venha do app ou do Claude (ver cald-mcp.ts). */
export class WorkspaceStore extends EventEmitter {
  private workspaces: Workspace[] = [];
  private writing = Promise.resolve();

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(FILE, 'utf8')) as { workspaces?: Workspace[] };
      const list = Array.isArray(data.workspaces) ? data.workspaces.filter((w) => w && typeof w.id === 'string') : [];
      // Arquivo de antes do workspace padrão: cada projeto fica com o workspace de que ele é o principal
      // (o editado por último, se for de mais de um).
      const before = list.length > 0 && list.every((w) => !Array.isArray(w.defaultFor));
      this.workspaces = list.map((w) => ({ ...w, defaultFor: Array.isArray(w.defaultFor) ? w.defaultFor.filter((p) => w.projects.includes(p)) : [] }));
      if (before) {
        for (const ws of [...this.workspaces].sort((a, b) => b.updatedAt - a.updatedAt)) {
          const main = ws.projects[0];
          if (main && !this.defaultOf(main)) ws.defaultFor = [main];
        }
        await this.persist();
      }
    } catch {
      // Primeiro uso ou arquivo ilegível: começa vazio.
    }
  }

  list(): Workspace[] {
    return this.workspaces;
  }

  find(id: string): Workspace | undefined {
    return this.workspaces.find((w) => w.id === id);
  }

  get(id: string): Workspace {
    const ws = this.find(id);
    if (!ws) throw new HttpError(404, 'workspace_not_found');
    return ws;
  }

  /** O workspace padrão do projeto, se ele tem um. */
  defaultOf(project: string): Workspace | undefined {
    return this.workspaces.find((w) => w.defaultFor.includes(project));
  }

  /** Faz de um workspace (que tenha o projeto) o padrão do projeto; `null` deixa o projeto sem padrão. */
  async setDefault(project: string, id: string | null): Promise<Workspace[]> {
    if (id && !this.get(id).projects.includes(project)) throw new HttpError(400, 'workspace_missing_project');
    this.workspaces = this.workspaces.map((w) => {
      const defaultFor = w.defaultFor.filter((p) => p !== project);
      return { ...w, defaultFor: w.id === id ? [...defaultFor, project] : defaultFor };
    });
    await this.persist();
    return this.workspaces;
  }

  /** Cria (sem `id`) ou substitui; os arquivos ficam como estão (eles têm rotas próprias). */
  async save(input: WorkspaceInput): Promise<Workspace> {
    const old = input.id ? this.get(input.id) : undefined;
    const name = input.name.trim();
    if (!name) throw new HttpError(400, 'workspace_name_required');
    const projects = unique(input.projects).slice(0, MAX_PROJECTS);
    // O novo vira o padrão do projeto principal dele, se esse projeto ainda não tem um.
    const main = projects[0];
    const defaultFor = old ? old.defaultFor.filter((p) => projects.includes(p)) : main && !this.defaultOf(main) ? [main] : [];
    const ws: Workspace = {
      id: old?.id ?? randomUUID(),
      name,
      color: Math.max(0, Math.floor(input.color || 0)),
      projects,
      instructions: input.instructions.trim().slice(0, MAX_INSTRUCTIONS),
      rules: unique(input.rules).slice(0, MAX_RULES),
      commands: input.commands
        .map((c) => ({ label: c.label.trim(), command: c.command.trim(), cwd: c.cwd || undefined }))
        .filter((c) => c.command)
        .slice(0, MAX_COMMANDS),
      teamId: input.teamId || undefined,
      files: old?.files ?? [],
      defaultFor,
      updatedAt: Date.now(),
    };
    this.workspaces = [...this.workspaces.filter((w) => w.id !== ws.id), ws].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    await this.persist();
    return ws;
  }

  /**
   * Workspaces vindos de outra máquina (ver config-sync.ts), com os projetos já nos caminhos daqui:
   * entram com o mesmo id, a data da edição de lá e os arquivos de contexto, que trocam os daqui.
   * O projeto de que um deles é o padrão deixa de ser padrão de outro.
   */
  async importWorkspaces(list: { ws: Workspace; files: { id: string; name: string; data: Buffer }[] }[]): Promise<void> {
    if (!list.length) return;
    for (const { ws, files } of list) {
      const dir = join(FILES_DIR, ws.id);
      await rm(dir, { recursive: true, force: true });
      for (const f of files) {
        if (!/^[\w-]{1,64}$/.test(f.id)) continue;
        await mkdir(join(dir, f.id), { recursive: true });
        await writeFile(join(dir, f.id, safeName(f.name)), f.data);
      }
      const projects = unique(ws.projects).slice(0, MAX_PROJECTS);
      const defaultFor = ws.defaultFor.filter((p) => projects.includes(p));
      const next: Workspace = { ...ws, projects, defaultFor, files: ws.files.filter((f) => files.some((x) => x.id === f.id)) };
      this.workspaces = [
        ...this.workspaces.filter((w) => w.id !== ws.id).map((w) => ({ ...w, defaultFor: w.defaultFor.filter((p) => !defaultFor.includes(p)) })),
        next,
      ].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    }
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    this.workspaces = this.workspaces.filter((w) => w.id !== id);
    await this.persist();
    await rm(join(FILES_DIR, id), { recursive: true, force: true });
  }

  /** Um arquivo de contexto novo (em base64, como os anexos do chat). */
  async addFile(id: string, file: { name: string; mediaType: string; data: string }): Promise<Workspace> {
    const ws = this.get(id);
    if (ws.files.length >= MAX_FILES) throw new HttpError(400, 'workspace_too_many_files', { max: MAX_FILES });
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, 'attachment_too_large', { name: file.name });
    const fileId = randomUUID();
    const dir = join(FILES_DIR, id, fileId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, safeName(file.name)), bytes);
    const entry = { id: fileId, name: file.name, mediaType: file.mediaType || 'application/octet-stream', size: bytes.length };
    return this.replaceFiles(ws, [...ws.files, entry]);
  }

  async removeFile(id: string, fileId: string): Promise<Workspace> {
    const ws = this.get(id);
    if (/^[\w-]{1,64}$/.test(fileId)) await rm(join(FILES_DIR, id, fileId), { recursive: true, force: true });
    return this.replaceFiles(
      ws,
      ws.files.filter((f) => f.id !== fileId),
    );
  }

  /** Onde o arquivo está no PC; `null` se não existe mais. */
  async filePath(id: string, fileId: string): Promise<string | null> {
    if (!/^[\w-]{1,64}$/.test(id) || !/^[\w-]{1,64}$/.test(fileId)) return null;
    const names = await readdir(join(FILES_DIR, id, fileId)).catch(() => []);
    return names[0] ? join(FILES_DIR, id, fileId, names[0]) : null;
  }

  /** A pasta dos arquivos do workspace: entra nas pastas extras da conversa, para o Claude poder lê-los. */
  filesDir(id: string): string {
    return join(FILES_DIR, id);
  }

  private async replaceFiles(ws: Workspace, files: WorkspaceFile[]): Promise<Workspace> {
    const next = { ...ws, files, updatedAt: Date.now() };
    this.workspaces = this.workspaces.map((w) => (w.id === ws.id ? next : w));
    await this.persist();
    return next;
  }

  // Gravação atômica e em fila: um arquivo temporário renomeado por cima do atual.
  private persist(): Promise<void> {
    const snapshot = JSON.stringify({ workspaces: this.workspaces }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(FILE), { recursive: true });
      await writeFile(`${FILE}.tmp`, snapshot);
      await rename(`${FILE}.tmp`, FILE);
    });
    this.emit('change');
    return this.writing;
  }

  /**
   * O que a conversa recebe do workspace, montado agora: um trecho do prompt de sistema e as pastas
   * extras (os outros projetos e a dos arquivos). `cwd` é a pasta em que ela abriu.
   */
  async context(id: string, cwd: string): Promise<{ prompt: string; directories: string[] } | null> {
    const ws = this.find(id);
    if (!ws) return null;
    // Num worktree, o projeto de que ele é cópia não entra como pasta extra: é o checkout de outras conversas.
    const mirrored = worktreeOf(cwd)?.project;
    const others = ws.projects.filter((p) => p !== cwd && p !== mirrored);
    const parts = [`# Workspace: ${ws.name}`, 'Esta conversa faz parte de um workspace do cald, com o contexto abaixo, que vale para todas as conversas dele.'];
    parts.push(
      `Projeto desta conversa: ${cwd}` + (others.length ? `\nOutros projetos do workspace (você também pode ler e editar): ${others.join(', ')}` : ''),
    );
    if (ws.instructions) parts.push(`## Instruções\n${ws.instructions}`);
    if (ws.rules.length) parts.push(`## Regras (padrões do workspace)\n${ws.rules.map((r) => `- ${r}`).join('\n')}`);
    if (ws.commands.length) {
      parts.push(
        `## Comandos para validar\nUse estes antes de dar algo por pronto (e passe-os a quem do time for testar):\n${ws.commands
          .map((c) => `- ${c.label || 'Comando'}${c.cwd ? ` (em ${c.cwd})` : ''}: \`${c.command}\``)
          .join('\n')}`,
      );
    }
    const files = await Promise.all(ws.files.map(async (f) => ({ ...f, path: await this.filePath(ws.id, f.id) })));
    const inline: string[] = [];
    const byPath: string[] = [];
    let budget = INLINE_BUDGET;
    for (const f of files) {
      if (!f.path) continue;
      const text = TEXT.test(f.mediaType) || TEXT_EXT.has(extname(f.name).toLowerCase());
      if (text && f.size <= budget) {
        const body = await readFile(f.path, 'utf8').catch(() => null);
        if (body !== null) {
          budget -= f.size;
          inline.push(`### ${f.name}\n\`\`\`\n${body}\n\`\`\``);
          continue;
        }
      }
      byPath.push(`- ${f.name}: ${f.path}`);
    }
    if (inline.length || byPath.length) {
      parts.push(
        [
          '## Arquivos de contexto',
          ...inline,
          byPath.length ? `Estes ficam no PC; leia quando forem relevantes para o pedido:\n${byPath.join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    }
    return { prompt: parts.join('\n\n'), directories: [...others, ...(files.length ? [this.filesDir(ws.id)] : [])] };
  }
}

export const tagOf = (ws: Workspace): WorkspaceTag => ({ id: ws.id, name: ws.name, color: ws.color });
