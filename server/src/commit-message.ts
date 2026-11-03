import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { childEnv } from './config.ts';
import { HttpError } from './errors.ts';
import { gitPending } from './git.ts';
import { hiddenSessions } from './live.ts';

/** O que o Claude sugere para o commit: a mensagem e um nome de branch, para quem está na main. */
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
 * Pede ao Claude (Haiku, rápido) a mensagem do próximo commit: o staged, ou tudo com `all`, no
 * jeito dos últimos commits do repositório. Roda isolado: sem ferramentas, sem as configurações e
 * hooks seus nem o CLAUDE.md (que mudariam o texto), e sem gravar conversa.
 */
export async function suggestCommit(cwd: string, all: boolean): Promise<CommitSuggestion> {
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
  // Fora da lista de conversas vivas: é só uma consulta, não um claudinho novo.
  const sessionId = randomUUID();
  hiddenSessions.add(sessionId);
  const q = query({
    prompt,
    options: {
      cwd,
      env: childEnv(),
      model: 'haiku',
      systemPrompt: SYSTEM,
      tools: [],
      settingSources: [],
      persistSession: false,
      thinking: { type: 'disabled' },
      maxTurns: 1,
      abortController: abort,
      sessionId,
    },
  });
  let text = '';
  try {
    for await (const msg of q) {
      if (msg.type !== 'result') continue;
      if (msg.subtype !== 'success') throw new HttpError(502, 'suggest_failed');
      text = msg.result;
      break;
    }
  } catch (err) {
    if (abort.signal.aborted) throw new HttpError(504, 'suggest_timeout');
    throw err instanceof HttpError ? err : new HttpError(502, 'suggest_failed');
  } finally {
    clearTimeout(timer);
    q.close();
    // O processo leva um instante para sair da lista do `claude agents`.
    setTimeout(() => hiddenSessions.delete(sessionId), 60_000);
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
