import { HttpError } from './errors.ts';
import { git, gitPending, requireRepo } from './git.ts';
import type { AgentProvider } from './providers/types.ts';

/** Um commit do plano: a mensagem inteira e os arquivos que vão nele. */
export type PlannedCommit = { message: string; files: string[] };

/** O que já dá para mostrar enquanto o agente escreve: os textos, até onde ele chegou. */
export type PartialPlan = { title?: string; body?: string; branch?: string };

/**
 * O valor de um campo de texto num JSON ainda pela metade, até onde já veio (com os escapes já
 * desfeitos); `undefined` se o campo ainda não começou.
 */
function partialString(json: string, key: string): string | undefined {
  const start = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!start) return undefined;
  const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
  let out = '';
  for (let i = start.index + start[0].length; i < json.length; i++) {
    const c = json[i]!;
    if (c === '"') return out;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = json[i + 1];
    // O escape ainda não chegou inteiro: para aqui e espera o próximo pedaço.
    if (next === undefined) return out;
    if (next === 'u') {
      const hex = json.slice(i + 2, i + 6);
      if (hex.length < 4) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else {
      out += ESCAPES[next] ?? next;
      i++;
    }
  }
  return out;
}

/** O PR organizado pelo agente, para a tela de abrir PR preencher: você revisa e abre pelo botão. */
export type PullPlan = { title: string; body: string; branch: string; commits: PlannedCommit[]; labels: string[] };

const TIMEOUT_MS = 5 * 60_000;

const TASK = `# Organizar um pull request

The user is on cald's "Abrir PR" screen and asked you to organize the pull request, the way they would by
typing "abrir PR" in a conversation. Follow the user's own conventions: their CLAUDE.md and any skills
about commits, branches or pull requests (load the ones that apply with the Skill tool and follow their
writing rules: language, message format, branch naming, PR description template). With none, follow the
repository's recent commit messages.

Return:
- title: the pull request title.
- body: the pull request description in Markdown.
- branch: a name for the new branch, when the current branch is the default one (otherwise the current name).
- commits: the uncommitted changes split into logical commits, in order, each with its full message and
  its files, using the paths exactly as listed. Leave out files that do not belong in this pull request.
  Commits the branch already has go in as they are: do not list them.
- labels: the repository labels that fit this pull request, only from the list given (none if none fit).
  Follow the user's skills when they say how to label.

You only read. Do not run commands, edit files, commit, push, create branches or open the pull request:
the user reviews what you return and opens it with the button. When a skill says to run steps, take only
its writing rules from it.`;

const SCHEMA = {
  type: 'object',
  required: ['title', 'body', 'branch', 'commits', 'labels'],
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
    branch: { type: 'string' },
    commits: {
      type: 'array',
      items: {
        type: 'object',
        required: ['message', 'files'],
        properties: { message: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } },
      },
    },
    labels: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * Pede ao agente o PR organizado: título, descrição, branch e a divisão do não commitado em commits.
 * Ele recebe o que a tela sabe (a branch, os commits que ela já tem, os arquivos e o diff) e o que você
 * já escreveu, e responde no formato de `SCHEMA`; arquivos fora da lista são descartados.
 */
export async function planPull(
  provider: AgentProvider,
  cwd: string,
  /** `labels`: as etiquetas do repositório, que a tela já tem; o agente escolhe entre elas. */
  draft: { base: string; title?: string; body?: string; labels?: string[]; model?: string; effort?: string },
  /** Quem pediu desistiu (o "Parar" na tela): o agente para junto. */
  cancel?: AbortSignal,
  /** Os textos enquanto ele escreve: a tela vai mostrando, como no chat. */
  onPartial?: (partial: PartialPlan) => void,
): Promise<PullPlan> {
  if (!provider.assist) throw new HttpError(501, 'assist_unsupported');
  const status = await requireRepo(cwd);
  const files = status.files.map((f) => f.path);
  const [pending, branchLog] = await Promise.all([
    files.length ? gitPending(cwd, true) : null,
    git(cwd, ['log', '--format=%h %s', '-n', '50', `origin/${draft.base}..HEAD`]).then(
      (r) => r.stdout.trim(),
      () => '',
    ),
  ]);
  const onBase = status.branch === draft.base;
  const prompt = [
    `Repository: ${cwd}`,
    `Current branch: ${status.branch ?? '(detached)'}; the pull request goes into ${draft.base}.${onBase ? ' The current branch is the default one: the pull request leaves from a new branch.' : ''}`,
    branchLog ? `Commits the branch already has, not in origin/${draft.base}:\n${branchLog}` : 'The branch has no commits of its own yet.',
    files.length
      ? `Uncommitted files (git status code, path):\n${status.files.map((f) => `${f.untracked ? '??' : `${f.index}${f.worktree}`} ${f.path}`).join('\n')}`
      : 'There are no uncommitted files.',
    draft.labels?.length ? `Repository labels: ${draft.labels.join(', ')}` : 'The repository has no labels.',
    draft.title?.trim() || draft.body?.trim()
      ? `What the user already wrote (use it as a hint, improve it):\nTitle: ${draft.title?.trim() ?? ''}\nDescription:\n${draft.body?.trim() ?? ''}`
      : '',
    pending?.log.length ? `Recent commit messages, newest first:\n\n${pending.log.map((m) => `<commit>\n${m}\n</commit>`).join('\n')}` : '',
    pending ? `Diff of the uncommitted changes:\n\n${pending.stat}\n\n${pending.patch}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  cancel?.addEventListener('abort', () => abort.abort(), { once: true });
  let out: unknown;
  try {
    out = await provider.assist({
      cwd,
      task: TASK,
      prompt,
      schema: SCHEMA,
      signal: abort.signal,
      model: draft.model,
      effort: draft.effort,
      onPartial: onPartial && ((json) => onPartial({ title: partialString(json, 'title'), body: partialString(json, 'body'), branch: partialString(json, 'branch') })),
    });
  } catch {
    if (cancel?.aborted) throw new HttpError(499, 'assist_cancelled');
    if (abort.signal.aborted) throw new HttpError(504, 'assist_timeout');
    throw new HttpError(502, 'assist_failed');
  } finally {
    clearTimeout(timer);
  }

  const plan = out as Partial<PullPlan> | null;
  if (!plan || typeof plan.title !== 'string') throw new HttpError(502, 'assist_failed');
  const known = new Set(files);
  const seen = new Set<string>();
  const commits = (plan.commits ?? [])
    .map((c) => ({
      message: String(c.message ?? '').trim(),
      // Cada arquivo num commit só, e só os que existem: o agente pode errar um caminho.
      files: (c.files ?? []).filter((f) => known.has(f) && !seen.has(f) && seen.add(f)),
    }))
    .filter((c) => c.message && c.files.length);
  const branch = String(plan.branch ?? '')
    .trim()
    .replace(/[^\w./-]+/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '');
  // Só as que existem no repositório: o `gh pr create` recusa etiqueta desconhecida.
  const offered = new Set(draft.labels ?? []);
  const labels = [...new Set((plan.labels ?? []).filter((l) => offered.has(l)))];
  return { title: plan.title.trim(), body: String(plan.body ?? '').trim(), branch: onBase ? branch : (status.branch ?? branch), commits, labels };
}
