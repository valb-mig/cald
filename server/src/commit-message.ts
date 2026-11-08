import { HttpError } from './errors.ts';
import { gitPending } from './git.ts';
import type { AgentProvider } from './providers/types.ts';

/** O que o agente sugere para o commit: a mensagem e um nome de branch, para quem está na main. */
export type CommitSuggestion = { message: string; branch: string };

const TIMEOUT_MS = 60_000;

const SYSTEM = `You write git commit messages for the changes the user is about to commit.

Follow the repository's own convention, taken from its recent commit messages: the same language,
prefix style (e.g. Conventional Commits with scope), casing, subject length and whether there is a
body and how it is written, wrapped at the same width. With no history, use Conventional Commits in English. Describe what
changed and why in the user's terms, not file by file. Never add trailers (Co-Authored-By,
Signed-off-by) or mention AI.

Also give a short git branch name for this change, in kebab-case, starting with the commit type when
the convention has one (e.g. "fix-terminal-home", "feat-commit-suggestion"). No prefix before it.

Answer with JSON only, no code fence: {"message": "<full commit message>", "branch": "<branch name>"}`;

/**
 * Pede ao agente a mensagem do próximo commit: o staged, ou tudo com `all`, no jeito dos últimos
 * commits do repositório. É uma resposta avulsa (`complete`, ver providers/types.ts): sem ferramentas,
 * sem as suas configurações e sem gravar conversa.
 */
export async function suggestCommit(provider: AgentProvider, cwd: string, all: boolean): Promise<CommitSuggestion> {
  if (!provider.complete) throw new HttpError(501, 'suggest_unsupported');
  const pending = await gitPending(cwd, all);
  const prompt = [
    pending.log.length
      ? `Recent commit messages, newest first:\n\n${pending.log.map((m) => `<commit>\n${m}\n</commit>`).join('\n')}`
      : 'The repository has no commits yet.',
    `Files in this commit:\n\n${pending.stat}`,
    `Diff:\n\n${pending.patch}`,
  ].join('\n\n');

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  let text: string;
  try {
    text = await provider.complete({ cwd, system: SYSTEM, prompt, signal: abort.signal });
  } catch {
    if (abort.signal.aborted) throw new HttpError(504, 'suggest_timeout');
    throw new HttpError(502, 'suggest_failed');
  } finally {
    clearTimeout(timer);
  }

  const parsed = parse(text);
  if (!parsed) throw new HttpError(502, 'suggest_failed');
  const slug = parsed.branch
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
    .slice(0, 60);
  return { message: parsed.message.trim(), branch: pending.user && slug ? `${pending.user}/${slug}` : slug };
}

/** O JSON da resposta, mesmo que venha dentro de um bloco de código. */
function parse(text: string): CommitSuggestion | null {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const out = JSON.parse(json) as Partial<CommitSuggestion>;
    if (typeof out.message !== 'string' || !out.message.trim()) return null;
    return { message: out.message, branch: typeof out.branch === 'string' ? out.branch : '' };
  } catch {
    return null;
  }
}
