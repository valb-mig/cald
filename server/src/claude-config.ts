import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentInfo, McpServerStatus, Query, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_HOME, CLAUDE_JSON } from './config.ts';
import { HttpError } from './errors.ts';
import { readFields, splitFrontmatter } from './frontmatter.ts';

/**
 * O que o Claude Code carrega numa pasta: skills, comandos, subagentes e servidores MCP. A lista
 * vem do próprio Claude (uma sonda, ou a conversa do painel aberta ali), que é quem sabe o que vale;
 * o disco diz de onde cada um veio (do projeto, seus, do claude.ai, de um plugin) e o texto deles.
 */

export type ClaudeItemKind = 'skill' | 'command' | 'agent';
/** `claude.ai`: as skills sincronizadas da sua conta; `builtin`: as do próprio Claude Code. */
export type ClaudeItemSource = 'project' | 'user' | 'claude.ai' | 'plugin' | 'builtin';

export type ClaudeItem = {
  kind: ClaudeItemKind;
  name: string;
  description: string;
  source: ClaudeItemSource;
  plugin: string | null;
  /** O arquivo (SKILL.md, o .md do agente ou do comando), quando achado no disco. */
  path: string | null;
  model: string | null;
  /** Servidores MCP que o texto cita, e se estão ligados nesta pasta. */
  mentions: { name: string; here: boolean }[];
  /** Desligada pelo `skillOverrides` das settings: o Claude não a vê (nem o /nome). */
  enabled: boolean;
  /** Liga e desliga pelo `skillOverrides`: skills e comandos que não são de plugin (esses vão pelo plugin). */
  canToggle: boolean;
  /** Pode ir para a lixeira do cald: só os arquivos seus e os do projeto. */
  canTrash: boolean;
};

export type McpStatus = McpServerStatus['status'];

export type McpServer = {
  name: string;
  status: McpStatus;
  /** De onde vem a configuração: user, project, local, claudeai, dynamic (plugin)… */
  scope: string | null;
  error: string | null;
  transport: string | null;
  /** O comando ou o endereço, sem segredo: argumentos com cara de chave e a query da URL saem. */
  target: string | null;
  /** Os nomes das variáveis e cabeçalhos; os valores não saem do PC. */
  secrets: string[];
  tools: { name: string; description: string | null }[];
  /** O plugin que traz este servidor (`nome@marketplace`): ligar e desligar é pelo plugin. */
  plugin: string | null;
};

/** Um servidor configurado só em outras pastas (escopo local, ou o `.mcp.json` de outro projeto). */
export type McpElsewhere = { name: string; scope: 'local' | 'project'; projects: string[] };

/** Um plugin instalado; `mcp`: ele traz servidores MCP. */
export type PluginInfo = { key: string; name: string; enabled: boolean; mcp: boolean };

export type ClaudeSetup = { cwd: string; items: ClaudeItem[]; mcp: McpServer[]; elsewhere: McpElsewhere[]; plugins: PluginInfo[]; at: number };

/** O que o Claude devolve; `describeSetup` junta o resto. */
export type RawSetup = { commands: SlashCommand[]; agents: AgentInfo[]; mcp: McpServerStatus[] };

// Os servidores levam um tempo para conectar: espera sair do "pending", até este limite.
const MCP_SETTLE_MS = 10_000;
const MAX_TEXT = 200_000;

async function settleMcp(q: Query): Promise<McpServerStatus[]> {
  const until = Date.now() + MCP_SETTLE_MS;
  for (;;) {
    const list = await q.mcpServerStatus();
    if (!list.some((s) => s.status === 'pending') || Date.now() > until) return list;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function probeSetup(q: Query): Promise<RawSetup> {
  const [commands, agents, mcp] = await Promise.all([q.supportedCommands(), q.supportedAgents(), settleMcp(q)]);
  return { commands, agents, mcp };
}

type Found = { kind: ClaudeItemKind; source: ClaudeItemSource; plugin: string | null; path: string };

const readText = (path: string) => readFile(path, 'utf8').then((t) => t.slice(0, MAX_TEXT), () => null);
// As configs vão inteiras: o ~/.claude.json passa fácil de centenas de KB, e cortado não abre.
export const readJson = <T>(path: string): Promise<T | null> =>
  readFile(path, 'utf8').then(
    (t) => JSON.parse(t) as T,
    () => null,
  );
const nameIn = async (path: string) => readFields(splitFrontmatter((await readText(path)) ?? '')?.head ?? []).name;

// Uma skill por pasta (`<pasta>/SKILL.md`), com o nome do cabeçalho ou o da pasta.
async function skillsIn(dir: string): Promise<{ name: string; path: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = await Promise.all(
    entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name !== 'synced')
      .map(async (e) => {
        const path = join(dir, e.name, 'SKILL.md');
        const text = await readText(path);
        if (text === null) return null;
        return { name: readFields(splitFrontmatter(text)?.head ?? []).name || e.name, path };
      }),
  );
  return out.filter((s) => s !== null);
}

// Um agente ou comando por arquivo `.md`; o agente com o nome do cabeçalho, o comando com o do arquivo.
async function markdownIn(dir: string, byHeader: boolean): Promise<{ name: string; path: string }[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.md'));
  return Promise.all(
    files.map(async (f) => ({ name: (byHeader && (await nameIn(join(dir, f)))) || basename(f, '.md'), path: join(dir, f) })),
  );
}

/** As suas configurações do Claude Code, onde ficam `skillOverrides` e `enabledPlugins`. */
export const USER_SETTINGS = join(CLAUDE_HOME, 'settings.json');

type PluginInstall = PluginInfo & { path: string };

// Os plugins instalados, com a pasta de cada um e se estão ligados nas suas configurações (`enabledPlugins`).
export async function installedPlugins(): Promise<PluginInstall[]> {
  const [installed, settings] = await Promise.all([
    readJson<{ plugins?: Record<string, { installPath?: string }[]> }>(join(CLAUDE_HOME, 'plugins', 'installed_plugins.json')),
    readJson<{ enabledPlugins?: Record<string, boolean> }>(USER_SETTINGS),
  ]);
  const enabled = settings?.enabledPlugins ?? {};
  const list = Object.entries(installed?.plugins ?? {}).flatMap(([key, installs]) => {
    const path = Array.isArray(installs) ? installs.at(-1)?.installPath : undefined;
    return path ? [{ key, name: key.split('@')[0], path, enabled: enabled[key] === true }] : [];
  });
  return Promise.all(list.map(async (p) => ({ ...p, mcp: (await readText(join(p.path, '.mcp.json'))) !== null })));
}

const plugins = async () => (await installedPlugins()).filter((p) => p.enabled);

/**
 * O `skillOverrides` que vale numa pasta: o seu, o do projeto e o local do projeto, nessa ordem de
 * força, como o Claude Code junta. Sem `withLocal`, o que valeria sem o local (para saber se ligar
 * aqui precisa de um "on" explícito).
 */
export async function skillOverrides(cwd: string, withLocal = true): Promise<Record<string, string>> {
  const files = [USER_SETTINGS];
  if (cwd !== homedir()) files.push(join(cwd, '.claude', 'settings.json'), ...(withLocal ? [join(cwd, '.claude', 'settings.local.json')] : []));
  const all = await Promise.all(files.map((f) => readJson<{ skillOverrides?: Record<string, string> }>(f)));
  return Object.assign({}, ...all.map((d) => d?.skillOverrides ?? {}));
}

/**
 * Onde cada skill, comando e agente está no disco, pelo nome com que o Claude o lista (os de plugin
 * com o prefixo `plugin:`). Os do projeto vêm por último e ganham dos seus com o mesmo nome, como no
 * Claude Code. Na pasta pessoal, o `.claude` do "projeto" é o seu, então não conta duas vezes.
 */
export async function onDisk(cwd: string): Promise<Map<string, Found>> {
  const found = new Map<string, Found>();
  const add = (list: { name: string; path: string }[], kind: ClaudeItemKind, source: ClaudeItemSource, plugin: string | null = null) => {
    for (const { name, path } of list) found.set(`${kind === 'agent' ? 'agent' : 'cmd'}:${plugin ? `${plugin}:` : ''}${name}`, { kind, source, plugin, path });
  };
  for (const p of await plugins()) {
    add(await skillsIn(join(p.path, 'skills')), 'skill', 'plugin', p.name);
    add(await markdownIn(join(p.path, 'commands'), false), 'command', 'plugin', p.name);
    add(await markdownIn(join(p.path, 'agents'), true), 'agent', 'plugin', p.name);
  }
  for (const bucket of await readdir(join(CLAUDE_HOME, 'skills', 'synced')).catch(() => [] as string[])) {
    add(await skillsIn(join(CLAUDE_HOME, 'skills', 'synced', bucket)), 'skill', 'claude.ai');
  }
  add(await skillsIn(join(CLAUDE_HOME, 'skills')), 'skill', 'user');
  add(await markdownIn(join(CLAUDE_HOME, 'commands'), false), 'command', 'user');
  add(await markdownIn(join(CLAUDE_HOME, 'agents'), true), 'agent', 'user');
  if (cwd !== homedir()) {
    add(await skillsIn(join(cwd, '.claude', 'skills')), 'skill', 'project');
    add(await markdownIn(join(cwd, '.claude', 'commands'), false), 'command', 'project');
    add(await markdownIn(join(cwd, '.claude', 'agents'), true), 'agent', 'project');
  }
  return found;
}

/** O texto de uma skill, comando ou agente, só se ele for um dos que valem nesta pasta. */
export async function claudeItemText(cwd: string, path: string): Promise<string> {
  const known = [...(await onDisk(cwd)).values()].some((f) => f.path === path);
  const text = known ? await readText(path) : null;
  if (text === null) throw new HttpError(404, 'not_found');
  return text;
}

type McpConfig = { type?: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string> };

// O que tem cara de segredo: depois de `--token`, em `CHAVE=valor` (como no `-e` do docker), num
// cabeçalho `Authorization: …`, depois de `Bearer` ou uma sequência longa e aleatória.
const SECRET_NAME = /key|token|secret|pass|auth|cookie|credential|bearer/i;
const RANDOM = /^(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{24,}$/i;

function redactArg(arg: string, prev: string | undefined): string {
  const pair = /^(-{0,2}[\w.-]+)=/.exec(arg);
  if (pair) return SECRET_NAME.test(pair[1]) ? `${pair[1]}=•••` : arg;
  const header = /^([\w-]+):\s*\S/.exec(arg);
  if (header && (SECRET_NAME.test(header[1]) || /^(-H|--header)$/.test(prev ?? ''))) return `${header[1]}: •••`;
  if (prev && /^--?[\w-]+$/.test(prev) && SECRET_NAME.test(prev)) return '•••';
  return RANDOM.test(arg) ? '•••' : scrub(arg);
}

/** Texto livre (a mensagem de erro de um servidor) sem os segredos que ele possa repetir. */
function scrub(text: string): string {
  return text
    .replace(/(bearer\s+)\S+/gi, '$1•••')
    .replace(/((?:key|token|secret|pass|auth|cookie)[\w-]*["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1•••')
    .replace(/[\w-]{24,}/g, (m) => (RANDOM.test(m) ? '•••' : m));
}

// Sem usuário, senha, query nem trecho do caminho com cara de chave (há serviços que põem a chave ali).
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((part) => (RANDOM.test(part) ? '•••' : part))
      .join('/');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return '';
  }
}

function describeMcp(s: McpServerStatus, installed: PluginInfo[]): McpServer {
  const config = (s.config ?? {}) as McpConfig;
  const args = config.args ?? [];
  const target = config.url ? safeUrl(config.url) : config.command ? [config.command, ...args.map((a, i) => redactArg(a, args[i - 1]))].join(' ') : null;
  return {
    name: s.name,
    status: s.status,
    scope: s.scope ?? s.source ?? null,
    error: s.error ? scrub(s.error) : null,
    transport: config.type ?? (config.command ? 'stdio' : null),
    target: target || null,
    secrets: [...Object.keys(config.env ?? {}), ...Object.keys(config.headers ?? {})],
    tools: (s.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? null })),
    plugin: s.source === 'plugin' ? (installed.find((p) => p.name === s.name.split(':')[1])?.key ?? null) : null,
  };
}

// O nome com que um servidor aparece no texto: `plugin:figma:figma` é o figma; os do claude.ai têm espaço e ficam de fora.
const mcpBase = (name: string) => name.split(':').at(-1) ?? name;

/**
 * Os servidores configurados em outras pastas: os de escopo local (no ~/.claude.json, por pasta) e
 * os dos `.mcp.json` dos projetos conhecidos. Só os nomes e onde: nada da configuração em si.
 */
async function configuredElsewhere(projects: string[]): Promise<Map<string, McpElsewhere>> {
  const out = new Map<string, McpElsewhere>();
  const note = (name: string, scope: McpElsewhere['scope'], project: string) => {
    const key = `${scope}:${name}`;
    const hit = out.get(key) ?? { name, scope, projects: [] };
    if (!hit.projects.includes(project)) hit.projects.push(project);
    out.set(key, hit);
  };
  // Sem config, ou lida no meio de uma gravação do Claude Code: fica sem essa parte.
  const config = await readJson<{ projects?: Record<string, { mcpServers?: Record<string, unknown> }> }>(CLAUDE_JSON);
  for (const [project, p] of Object.entries(config?.projects ?? {})) for (const name of Object.keys(p?.mcpServers ?? {})) note(name, 'local', project);
  await Promise.all(
    projects.map(async (project) => {
      const mcp = await readJson<{ mcpServers?: Record<string, unknown> }>(join(project, '.mcp.json'));
      for (const name of Object.keys(mcp?.mcpServers ?? {})) note(name, 'project', project);
    }),
  );
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Junta o que o Claude listou com a origem e o texto de cada um, e os servidores que valem só em outras pastas. */
export async function describeSetup(cwd: string, raw: RawSetup, projects: string[]): Promise<ClaudeSetup> {
  const [disk, others, overrides, installed] = await Promise.all([onDisk(cwd), configuredElsewhere(projects), skillOverrides(cwd), installedPlugins()]);
  const mcp = raw.mcp.map((s) => describeMcp(s, installed));
  // Plugin desligado some da lista do Claude: o servidor dele aparece desligado, para dar para religar.
  for (const p of installed) {
    if (p.enabled || !p.mcp || mcp.some((m) => m.plugin === p.key)) continue;
    mcp.push({ name: `plugin:${p.name}`, status: 'disabled', scope: 'dynamic', error: null, transport: null, target: null, secrets: [], tools: [], plugin: p.key });
  }
  const here = new Set(mcp.filter((s) => s.status !== 'disabled').map((s) => mcpBase(s.name)));
  const elsewhere = [...others.values()]
    .map((e) => ({ ...e, projects: e.projects.filter((p) => p !== cwd).sort() }))
    .filter((e) => e.projects.length && !mcp.some((s) => s.name === e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = [...new Set([...mcp.filter((s) => !s.name.includes(' ')).map((s) => mcpBase(s.name)), ...elsewhere.map((e) => e.name)])].filter(
    (n) => n.length >= 3,
  );
  const patterns = names.map((name) => ({ name, re: new RegExp(`(^|[^\\w-])(mcp__)?${escape(name)}([^\\w-]|$)`, 'i') }));

  const item = async (kind: ClaudeItemKind, name: string, description: string, builtin: boolean, model: string | null): Promise<ClaudeItem> => {
    const hit = disk.get(`${kind === 'agent' ? 'agent' : 'cmd'}:${name}`);
    const plugin = hit?.plugin ?? (name.includes(':') ? name.split(':')[0] : null);
    const source: ClaudeItemSource = hit?.source ?? (builtin || !plugin ? 'builtin' : 'plugin');
    const text = hit ? ((await readText(hit.path)) ?? '') : '';
    const body = splitFrontmatter(text)?.body ?? text;
    const mentions = patterns.filter((p) => p.name !== plugin && p.re.test(body)).map((p) => ({ name: p.name, here: here.has(p.name) }));
    const finalKind = hit?.kind ?? kind;
    return {
      kind: finalKind,
      name,
      description,
      source,
      plugin,
      path: hit?.path ?? null,
      model,
      mentions,
      enabled: overrides[name] !== 'off',
      canToggle: finalKind !== 'agent' && (source === 'user' || source === 'project' || source === 'claude.ai'),
      canTrash: Boolean(hit) && (source === 'user' || source === 'project'),
    };
  };

  const items = await Promise.all([
    ...raw.commands.filter((c) => !c.name.startsWith('_')).map((c) => item('skill', c.name, c.description, Boolean(c.builtin), null)),
    ...raw.agents.map((a) => item('agent', a.name, a.description, false, a.model ?? null)),
  ]);
  // As desligadas somem da lista do Claude: voltam do disco (ou só pelo nome, as do próprio Claude Code), para dar para religar.
  const listed = new Set(items.filter((i) => i.kind !== 'agent').map((i) => i.name));
  for (const [key, f] of disk) {
    const name = key.slice(4);
    if (f.kind === 'agent' || f.plugin || listed.has(name) || overrides[name] !== 'off') continue;
    const description = readFields(splitFrontmatter((await readText(f.path)) ?? '')?.head ?? []).description ?? '';
    items.push(await item(f.kind, name, description, false, null));
    listed.add(name);
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== 'off' || listed.has(name)) continue;
    items.push({ ...(await item('skill', name, '', true, null)), canToggle: true });
  }
  return { cwd, items, mcp, elsewhere, plugins: installed.map(({ path: _, ...p }) => p), at: Date.now() };
}
