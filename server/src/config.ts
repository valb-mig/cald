import { existsSync, lstatSync, readdirSync, renameSync, rmdirSync, symlinkSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;

// Pelo app do PC (ver desktop/), o servidor roda no Node do próprio Electron, ligado por esta
// variável. Ela só vale na partida: sai daqui para não passar aos processos filhos, onde faria um app
// Electron aberto pelo terminal do painel (o VSCode, por exemplo) subir como Node.
delete env.ELECTRON_RUN_AS_NODE;

export const PORT = Number(env.PORT ?? 7337);

// Quem sobe o servidor de novo depois de ele sair (o reinício da atualização): o systemd, que marca
// os serviços com INVOCATION_ID, ou o app do PC. `null` rodando à mão.
export const SUPERVISOR = env.EDITR_SUPERVISOR ?? (env.INVOCATION_ID ? 'systemd' : null);
// Empacotado no app do PC, sem o repositório git ao lado: a atualização é a do app, não a do git.
export const PACKAGED = env.EDITR_PACKAGED === '1';

// Nome desta máquina no app quando há várias (ver machines.ts); por padrão, o do sistema.
export const MACHINE_NAME = env.MACHINE_NAME ?? hostname();
// Só escuta localmente; o acesso remoto entra via `tailscale serve`.
export const HOST = '127.0.0.1';

// Pastas do painel no PC: o que dura (listas, histórico), o estado (fixadas, avisos) e o cache.
export const DATA_DIR = join(homedir(), '.local', 'share', 'editr');
export const STATE_DIR = join(homedir(), '.local', 'state', 'editr');
export const CACHE_DIR = join(homedir(), '.cache', 'editr');

// O projeto se chamou claude-remote e depois cald: na primeira subida, a pasta antiga (a de verdade;
// a outra já é atalho para ela) muda de nome e fica como atalho para a nova, porque conversas e
// listas guardadas apontam para os caminhos antigos. Se a nova já existe (criada antes, pelo
// instalador do Whisper, por exemplo), o que só a antiga tem passa para ela; com algo nas duas, a
// antiga fica como está.
const LEGACY_NAMES = ['cald', 'claude-remote'];
for (const dir of [DATA_DIR, STATE_DIR, CACHE_DIR]) {
  for (const name of LEGACY_NAMES) {
    const legacy = join(dirname(dir), name);
    try {
      if (!lstatSync(legacy).isDirectory()) continue;
      if (!existsSync(dir)) renameSync(legacy, dir);
      else {
        for (const entry of readdirSync(legacy)) if (!existsSync(join(dir, entry))) renameSync(join(legacy, entry), join(dir, entry));
        if (readdirSync(legacy).length) continue;
        rmdirSync(legacy);
      }
      symlinkSync(basename(dir), legacy);
      break;
    } catch {
      // Sem essa pasta antiga.
    }
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
// o Claude Code não grava isso, e sem o arquivo o histórico só diria "pelo edit.r".
export const ORIGINS_FILE = env.ORIGINS_FILE ?? join(DATA_DIR, 'origins.jsonl');

// Quem usa o painel (ver access.ts): os aparelhos que já entraram, os acessos e tentativas barradas
// recentes e os aparelhos desconectados por você.
export const ACCESS_FILE = env.ACCESS_FILE ?? join(STATE_DIR, 'access.json');

// Raízes onde o painel pode iniciar sessões novas (separadas por ':').
export const PROJECT_ROOTS = (env.PROJECT_ROOTS ?? join(homedir(), 'Projects')).split(':').filter(Boolean);

// Origens extras aceitas pelo guard (ex.: Vite em dev), separadas por ','.
export const EXTRA_ORIGINS = (env.EXTRA_ORIGINS ?? '').split(',').filter(Boolean);

// Máquinas extras com o edit.r, além das achadas no Tailscale (ex.: outra instância em
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
