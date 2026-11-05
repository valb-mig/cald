import { existsSync, lstatSync, renameSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;

export const PORT = Number(env.PORT ?? 7337);

// Nome desta máquina no app quando há várias (ver machines.ts); por padrão, o do sistema.
export const MACHINE_NAME = env.MACHINE_NAME ?? hostname();
// Só escuta localmente; o acesso remoto entra via `tailscale serve`.
export const HOST = '127.0.0.1';

export const CLAUDE_HOME = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
// A config global do Claude Code (MCPs de cada projeto, entre outras coisas): fora da pasta, a não
// ser que CLAUDE_CONFIG_DIR mude o lugar das duas.
export const CLAUDE_JSON = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');

// Pastas do painel no PC: o que dura (listas, histórico), o estado (fixadas, avisos) e o cache.
export const DATA_DIR = join(homedir(), '.local', 'share', 'cald');
export const STATE_DIR = join(homedir(), '.local', 'state', 'cald');
export const CACHE_DIR = join(homedir(), '.cache', 'cald');

// O projeto se chamava claude-remote: na primeira subida, as pastas antigas mudam de nome e ficam
// como atalho para as novas, porque conversas e listas guardadas apontam para os caminhos antigos.
for (const dir of [DATA_DIR, STATE_DIR, CACHE_DIR]) {
  const legacy = join(dirname(dir), 'claude-remote');
  try {
    if (existsSync(dir) || !lstatSync(legacy).isDirectory()) continue;
    renameSync(legacy, dir);
    symlinkSync(basename(dir), legacy);
  } catch {
    // Instalação nova, sem pasta antiga.
  }
}

// Arquivos anexados pelo celular (um subdiretório por sessão).
export const UPLOADS_DIR = env.UPLOADS_DIR ?? join(CACHE_DIR, 'uploads');

// Build do frontend servido na mesma origem (sobrescrevível para testar outra versão).
export const WEB_DIST = env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url));

// Histórico de uso por dia (ver activity.ts): fica fora do cache, porque os transcripts de onde ele
// sai são apagados pelo Claude Code depois de ~30 dias.
export const ACTIVITY_FILE = env.ACTIVITY_FILE ?? join(DATA_DIR, 'activity.json');

// De que aparelho saiu cada mensagem mandada pelo app (ver origins.ts). Dura como os transcripts:
// o Claude Code não grava isso, e sem o arquivo o histórico só diria "pelo cald".
export const ORIGINS_FILE = env.ORIGINS_FILE ?? join(DATA_DIR, 'origins.jsonl');

// Quem usa o painel (ver access.ts): os aparelhos que já entraram, os acessos e tentativas barradas
// recentes e os aparelhos desconectados por você.
export const ACCESS_FILE = env.ACCESS_FILE ?? join(STATE_DIR, 'access.json');

// Raízes onde o painel pode iniciar sessões novas (separadas por ':').
export const PROJECT_ROOTS = (env.PROJECT_ROOTS ?? join(homedir(), 'Projects')).split(':').filter(Boolean);

// Origens extras aceitas pelo guard (ex.: Vite em dev), separadas por ','.
export const EXTRA_ORIGINS = (env.EXTRA_ORIGINS ?? '').split(',').filter(Boolean);

// Máquinas extras com o cald, além das achadas no Tailscale (ex.: outra instância em
// teste: `http://127.0.0.1:7338`), separadas por ','.
export const EXTRA_MACHINES = (env.EXTRA_MACHINES ?? '').split(',').filter(Boolean);

// Ditado pelo Whisper (whisper.cpp) para navegadores sem reconhecimento de voz, como o Firefox:
// o binário `whisper-cli` e o modelo (ver transcribe.ts e o README).
const WHISPER_DIR = join(DATA_DIR, 'whisper');
export const WHISPER_CLI = env.WHISPER_CLI ?? join(WHISPER_DIR, 'whisper.cpp', 'build', 'bin', 'whisper-cli');
export const WHISPER_MODEL = env.WHISPER_MODEL ?? join(WHISPER_DIR, 'models', 'ggml-small-q5_1.bin');

// Leitura em voz alta pelo Piper para o PC, onde a voz do navegador é a do espeak, robótica: o
// binário e a voz, com o `.onnx.json` ao lado (ver speak.ts e o README).
const PIPER_DIR = join(DATA_DIR, 'piper');
export const PIPER_BIN = env.PIPER_BIN ?? join(PIPER_DIR, 'piper', 'piper');
export const PIPER_VOICE = env.PIPER_VOICE ?? join(PIPER_DIR, 'voices', 'pt_BR-faber-medium.onnx');

// O seu tempo no painel vai para o WakaTime por este binário (ver wakatime.ts e o README).
export const WAKATIME_CLI = env.WAKATIME_CLI ?? join(homedir(), '.wakatime', 'wakatime-cli');
// Quantas horas de hoje enchem o anel do WakaTime na alça do PC.
export const WAKATIME_GOAL_HOURS = Number(env.WAKATIME_GOAL_HOURS ?? 4) || 4;

// Logins Tailscale autorizados; vazio = detectar o dono deste nó.
export const ALLOWED_LOGINS = (env.ALLOWED_LOGINS ?? '').split(',').filter(Boolean);

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
