import { HttpError } from './errors.ts';
import { gitStatus } from './git.ts';
import { githubItem, githubPatches, type DiffSide, type LineComment } from './github.ts';
import type { AgentProvider } from './providers/types.ts';
import { partialString } from './pull-plan.ts';

/**
 * A revisão de um PR por um agente, no seu jeito (o CLAUDE.md e as suas skills de revisão valem): um
 * resumo, o veredito que ele sugere e os comentários nas linhas, que a tela põe na sua revisão pendente
 * para você editar, apagar e enviar (ver web/src/components/project/pull-review.tsx). Ele só lê.
 */

export type ReviewVerdict = 'approve' | 'comment' | 'request-changes';
/** `dropped`: comentários que apontavam para linhas fora do diff, deixados de fora. */
export type ReviewPlan = { summary: string; verdict: ReviewVerdict; comments: LineComment[]; dropped: number };
/** O que já dá para mostrar enquanto ele escreve: o resumo até onde veio e quantos comentários já começou. */
export type PartialReview = { summary?: string; comments: number };

const TIMEOUT_MS = 10 * 60_000;
// O diff que vai no pedido, somando os arquivos (uns 100 mil tokens); o que passar fica só na lista, para ele ler se precisar.
const MAX_DIFF_CHARS = 400_000;
const MAX_COMMENTS = 50;

const TASK = `# Revisar um pull request

The user is on edit.r's pull request screen and asked you for a thorough code review, as a careful senior
reviewer of this codebase would do. Follow the user's conventions: their CLAUDE.md and any skills about code
review or the project's standards (load the ones that apply with the Skill tool and follow them). Read the
files around the changes when you need context (Read, Grep, Glob).

Look for what matters: bugs and wrong behavior, edge cases, security problems, data loss, race conditions,
broken contracts between parts of the code, errors left unhandled, and inconsistencies with how the codebase
already does things. Skip pure style nitpicks unless the project's rules ask for them. Do not comment just to
praise. Do not repeat points already raised in the existing review conversations.

Each comment points at lines of the diff, using the label before each line: "R<n>" is line n of the new
file (side RIGHT); "L<n>" is line n of the old file, a removed line (side LEFT). Use only labelled lines. For
a range, give startLine and line on the same side, inside the same @@ hunk. When a small, concrete fix is
clear, put it in the body as a GitHub suggestion block (\`\`\`suggestion) holding the full replacement for
exactly the commented lines (RIGHT side only).

Write the comments and the summary in the language of the pull request and of the user's instructions
(CLAUDE.md, skills). Be direct and specific: what is wrong, why it matters, what to do.

Return:
- summary: the overall review in Markdown, a few sentences with the main points. It becomes the body of the review.
- verdict: "approve" when it is good to merge; "request-changes" only for real problems that must be fixed
  before merging; "comment" otherwise.
- comments: the inline comments, each with path (exactly as listed), side, line, optional startLine, and body.

You only read. Do not run commands or edit anything: the user goes through your comments, edits or deletes
them, and sends the review.`;

const SCHEMA = {
  type: 'object',
  required: ['summary', 'verdict', 'comments'],
  properties: {
    summary: { type: 'string' },
    verdict: { type: 'string', enum: ['approve', 'comment', 'request-changes'] },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'side', 'line', 'body'],
        properties: {
          path: { type: 'string' },
          side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
          line: { type: 'integer' },
          startLine: { type: 'integer' },
          body: { type: 'string' },
        },
      },
    },
  },
};

/**
 * O diff de um arquivo com o rótulo de cada linha na frente (`R12`, a linha do arquivo novo; `L7`, uma
 * que saiu, no antigo), para o agente não precisar contar; e, de cada lado, em que trecho (`@@`) cada
 * linha está, para conferir o que ele devolver.
 */
function numbered(patch: string): { text: string; right: Map<number, number>; left: Map<number, number> } {
  const out: string[] = [];
  const right = new Map<number, number>();
  const left = new Map<number, number>();
  let oldNo = 0;
  let newNo = 0;
  let hunk = -1;
  for (const line of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk++;
      out.push(line);
    } else if (hunk < 0 || line.startsWith('\\')) {
      continue;
    } else if (line.startsWith('+')) {
      right.set(newNo, hunk);
      out.push(`R${newNo++} + ${line.slice(1)}`);
    } else if (line.startsWith('-')) {
      left.set(oldNo, hunk);
      out.push(`L${oldNo++} - ${line.slice(1)}`);
    } else {
      // Contexto: existe dos dois lados; o rótulo é o do novo, onde ele costuma ser comentado.
      right.set(newNo, hunk);
      left.set(oldNo++, hunk);
      out.push(`R${newNo++}   ${line.slice(1)}`);
    }
  }
  return { text: out.join('\n'), right, left };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * Pede a revisão ao agente. Ele recebe o PR (título, descrição, branches, as conversas que já existem) e
 * o diff de cada arquivo com as linhas rotuladas, e responde no formato de `SCHEMA`; o comentário que
 * aponta para uma linha fora do diff (que o GitHub recusaria) fica de fora, e o veredito num PR seu vira
 * comentário (o GitHub não deixa aprovar nem pedir mudanças no próprio PR).
 */
export async function planReview(
  provider: AgentProvider,
  cwd: string,
  number: number,
  opts: { model?: string; effort?: string },
  cancel?: AbortSignal,
  onPartial?: (partial: PartialReview) => void,
): Promise<ReviewPlan> {
  if (!provider.assist) throw new HttpError(501, 'assist_unsupported');
  const [item, { files }, local] = await Promise.all([githubItem(cwd, 'pr', number, false), githubPatches(cwd, { pr: number }), gitStatus(cwd).catch(() => null)]);
  if (!item.ok || item.item.kind !== 'pr') throw new HttpError(422, 'github_action_failed', { message: item.ok ? 'Não é um PR.' : (item.message ?? 'Não deu para ler o PR no GitHub.') });
  const pr = item.item;

  const lines = new Map<string, { right: Map<number, number>; left: Map<number, number> }>();
  const diffs: string[] = [];
  const left: string[] = [];
  let budget = MAX_DIFF_CHARS;
  for (const f of files) {
    const head = `### ${f.path} (${f.status}${f.previous ? `, was ${f.previous}` : ''}, +${f.additions} −${f.deletions})`;
    if (!f.patch) {
      left.push(`${f.path} (${f.status}): no diff from the API (binary or too big).`);
      continue;
    }
    const n = numbered(f.patch);
    if (n.text.length > budget) {
      left.push(`${f.path} (${f.status}, +${f.additions} −${f.deletions}): diff left out for size; read the file if it matters.`);
      continue;
    }
    budget -= n.text.length;
    lines.set(f.path, n);
    diffs.push(`${head}\n${n.text}`);
  }

  const onBranch = local?.branch === pr.branch;
  const talks = (pr.threads ?? [])
    .filter((t) => t.comments.some((c) => !c.pending))
    .map((t) => {
      const first = t.comments.find((c) => !c.pending)!;
      return `- ${t.path}:${t.line ?? t.originalLine ?? '?'}${t.resolved ? ' (resolved)' : ''}${t.outdated ? ' (outdated)' : ''} @${first.author ?? '?'}: ${clip(first.body.replace(/\s+/g, ' '), 300)}`;
    });
  const prompt = [
    `Pull request #${pr.number} in ${item.repo}: "${pr.title}"`,
    `Branch ${pr.branch} → ${pr.base}. Opened by @${pr.author ?? '?'}; you review as @${item.viewer}.${pr.mine ? ' This is the user\'s own pull request: GitHub only lets them comment on it, so use the verdict "comment".' : ''}`,
    `Local checkout: ${cwd}, on branch ${local?.branch ?? '(unknown)'}. ${onBranch ? 'It is the pull request branch, but may be behind or ahead of it: trust the diff.' : 'It is NOT the pull request branch: the local files may differ from the pull request. Trust the diff, and read local files only for the context around it.'}`,
    `Description:\n${pr.body.trim() || '(none)'}`,
    talks.length ? `Existing review conversations (do not repeat these points):\n${talks.join('\n')}` : '',
    pr.comments.length ? `Recent comments on the pull request:\n${pr.comments.slice(-10).map((c) => `- @${c.author ?? '?'}: ${clip(c.body.replace(/\s+/g, ' '), 300)}`).join('\n')}` : '',
    `Changed files: ${files.length}${files.length < pr.changedFiles ? ` of ${pr.changedFiles}` : ''}.`,
    left.length ? `Files without a diff here:\n${left.join('\n')}` : '',
    `Diffs, with line labels:\n\n${diffs.join('\n\n')}`,
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
      model: opts.model,
      effort: opts.effort,
      onPartial: onPartial && ((json) => onPartial({ summary: partialString(json, 'summary'), comments: json.match(/"body"\s*:/g)?.length ?? 0 })),
    });
  } catch {
    if (cancel?.aborted) throw new HttpError(499, 'review_cancelled');
    if (abort.signal.aborted) throw new HttpError(504, 'review_timeout');
    throw new HttpError(502, 'review_failed');
  } finally {
    clearTimeout(timer);
  }

  const plan = out as { summary?: unknown; verdict?: unknown; comments?: unknown } | null;
  if (!plan || typeof plan.summary !== 'string') throw new HttpError(502, 'review_failed');
  const raw = Array.isArray(plan.comments) ? (plan.comments as Record<string, unknown>[]) : [];
  const comments: LineComment[] = [];
  for (const c of raw) {
    const path = String(c.path ?? '');
    const side: DiffSide = c.side === 'LEFT' ? 'LEFT' : 'RIGHT';
    const line = Number(c.line);
    const body = String(c.body ?? '').trim();
    const map = side === 'LEFT' ? lines.get(path)?.left : lines.get(path)?.right;
    const hunk = map?.get(line);
    // Uma linha que o diff não tem: o GitHub recusaria a revisão inteira por ela.
    if (!body || hunk === undefined || comments.length >= MAX_COMMENTS) continue;
    const start = Number(c.startLine);
    // O trecho só vale dentro do mesmo `@@`; senão, o comentário fica na linha final.
    const startLine = Number.isInteger(start) && start < line && map!.get(start) === hunk ? start : undefined;
    comments.push({ path, side, line, ...(startLine ? { startLine, startSide: side } : {}), body });
  }
  const verdict: ReviewVerdict = pr.mine ? 'comment' : plan.verdict === 'approve' || plan.verdict === 'request-changes' ? plan.verdict : 'comment';
  return { summary: plan.summary.trim(), verdict, comments, dropped: raw.length - comments.length };
}
