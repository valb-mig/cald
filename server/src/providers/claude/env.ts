import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Onde o Claude Code guarda o que é dele, o binário que o cald roda e o ambiente do processo filho. */

const env = process.env;

export const CLAUDE_HOME = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
// A config global do Claude Code (MCPs de cada projeto, entre outras coisas): fora da pasta, a não
// ser que CLAUDE_CONFIG_DIR mude o lugar das duas.
export const CLAUDE_JSON = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');

// Fallback do polling de sessões vivas; o gatilho principal é o fs.watch.
export const LIVE_FALLBACK_POLL_MS = 10_000;

// Binário que acompanha o Agent SDK: mesma versão do protocolo usado pelo query().
function bundledClaudeBin(): string {
  const sdkRequire = createRequire(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`;
  return join(dirname(sdkRequire.resolve(pkg)), 'claude');
}

export const CLAUDE_BIN = env.CLAUDE_BIN ?? bundledClaudeBin();

// Variáveis herdadas de uma sessão Claude Code (ex.: servidor iniciado pelo VSCode)
// que fariam o processo filho se identificar errado.
const INHERITED_CLAUDE_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_AGENT_SDK_VERSION',
];

export function childEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'cald/0.1' };
  for (const key of INHERITED_CLAUDE_VARS) delete out[key];
  return out;
}
