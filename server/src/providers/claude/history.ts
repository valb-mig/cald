import { basename } from 'node:path';
import { deleteSession, getSessionInfo, getSessionMessages, listSessions, renameSession } from '@anthropic-ai/claude-agent-sdk';
import type { Sent } from '../../events.ts';
import type { ProviderHistory, SavedSession } from '../types.ts';
import { fromSessionMessage } from './messages.ts';
import { agentTranscript } from './subagents.ts';
import { transcriptCwd, transcriptFile, transcriptMarks, transcriptTimes } from './transcript.ts';

/**
 * Nome provisório que o Claude Code dá à sessão ("editr-86") até gerar o título;
 * nesse intervalo o primeiro prompt descreve melhor a conversa.
 */
function isDerivedName(title: string, cwd?: string): boolean {
  if (!cwd) return false;
  const slug = basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return new RegExp(`^${slug}-[0-9a-f]{2}$`).test(title);
}

// Quem gravou a mensagem, segundo o `entrypoint` do transcript. `sdk-ts` é o próprio edit.r (o Agent
// SDK), e `sdk-cli` é o `claude -p`, que se roda no terminal.
const VIA: Record<string, Sent['via']> = {
  cli: 'terminal',
  'sdk-cli': 'terminal',
  'claude-vscode': 'vscode',
  'claude-desktop': 'desktop',
  'sdk-ts': 'editr',
};

/** As conversas que o Claude Code guarda em ~/.claude, pelo Agent SDK e pelo próprio transcript. */
export const claudeHistory: ProviderHistory = {
  async list(): Promise<SavedSession[]> {
    const rows = await listSessions();
    // O SDK não achou o `cwd` (primeira mensagem com imagem, ver transcriptCwd): lê do transcript.
    await Promise.all(rows.filter((r) => !r.cwd).map(async (r) => (r.cwd = await transcriptCwd(r.sessionId))));
    return rows.map((s) => ({
      sessionId: s.sessionId,
      title: s.customTitle ?? s.summary,
      firstPrompt: s.firstPrompt,
      cwd: s.cwd,
      gitBranch: s.gitBranch,
      lastModified: s.lastModified,
    }));
  },

  async cwd(sessionId) {
    const info = await getSessionInfo(sessionId);
    return info ? (info.cwd ?? (await transcriptCwd(sessionId))) : undefined;
  },

  async uuids(sessionId) {
    return (await getSessionMessages(sessionId)).map((m) => m.uuid);
  },

  /** As mensagens, com o esforço de cada resposta, a hora de cada uma e por onde entrou cada prompt, do transcript. */
  async messages(sessionId) {
    const [messages, { efforts, prompts }, times] = await Promise.all([getSessionMessages(sessionId), transcriptMarks(sessionId), transcriptTimes(sessionId)]);
    return messages.map((m) => {
      const mark = prompts.get(m.uuid);
      return {
        uuid: m.uuid,
        events: (sink) => fromSessionMessage(m, sink, efforts.get(m.uuid)),
        time: times.get(m.uuid),
        prompt: mark && { at: mark.at, via: mark.entrypoint ? VIA[mark.entrypoint] : undefined },
      };
    });
  },

  async version(sessionId) {
    const f = await transcriptFile(sessionId);
    return f ? `${f.size}:${f.mtimeMs}` : '-';
  },

  provisional: isDerivedName,

  /** Título gravado no próprio Claude Code: aparece também no /resume do terminal. */
  rename: (sessionId, title) => renameSession(sessionId, title),

  /** Apaga o transcript e os subagentes da conversa. */
  delete: (sessionId) => deleteSession(sessionId),

  subagent: agentTranscript,
};
