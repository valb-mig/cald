import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { WAKATIME_CLI, WAKATIME_GOAL_HOURS } from './config.ts';

/**
 * O seu tempo no painel, para o WakaTime. O `wakatime-cli` já lê sozinho os transcritos do Claude
 * (o que ele escreve e edita), mas nada sabe do tempo que você passa do outro lado: lendo a
 * resposta, conferindo um diff, escrevendo a próxima mensagem. Daqui sai um heartbeat para isso,
 * com as mesmas regras dos plugins de editor: um por arquivo a cada dois minutos, no máximo.
 *
 * Sem o wakatime-cli instalado, nada acontece. Para desligar: `WAKATIME=0`.
 */

/** Categorias do WakaTime que o painel usa (ver `wakatime-cli --help`). */
export type WakaCategory = 'code reviewing' | 'planning' | 'coding';

const EVERY_MS = 2 * 60_000;
const PLUGIN = 'editr/1.0.0 editr-wakatime/1.0.0';

const sent = new Map<string, number>();
let cli: string | null | undefined;

/** Caminho do wakatime-cli, achado uma vez; `null` quando não está instalado. */
async function findCli(): Promise<string | null> {
  if (cli !== undefined) return cli;
  if (process.env.WAKATIME === '0') return (cli = null);
  cli = await access(WAKATIME_CLI).then(
    () => WAKATIME_CLI,
    () => null,
  );
  return cli;
}

/**
 * Um heartbeat pelo que você está fazendo no painel. `file` é o arquivo aberto; sem ele, vale a
 * pasta do projeto (é assim que o WakaTime sabe de qual projeto é o tempo). Não espera o envio:
 * o cli leva uns segundos e a resposta do painel não tem por que ficar esperando por isso.
 */
export async function wakatime(o: { cwd?: string; file?: string; category: WakaCategory; write?: boolean }): Promise<void> {
  const entity = o.file || o.cwd;
  if (!entity) return;
  const path = await findCli();
  if (!path) return;

  const now = Date.now();
  const last = sent.get(entity);
  // Salvar sempre conta, como nos plugins de editor: é o que diz que o tempo foi escrevendo.
  if (!o.write && last && now - last < EVERY_MS) return;
  sent.set(entity, now);
  // O mapa só guarda o que ainda segura o próximo envio.
  if (sent.size > 200) for (const [k, at] of sent) if (now - at >= EVERY_MS) sent.delete(k);

  const args = ['--entity', entity, '--category', o.category, '--plugin', PLUGIN];
  if (o.cwd) args.push('--project-folder', o.cwd);
  if (o.write) args.push('--write');
  execFile(path, args, { timeout: 30_000 }, () => {
    // Sem rede ou sem chave, o próprio cli guarda o heartbeat para mandar depois: nada a fazer aqui.
  });
}

/** Quanto você já codou hoje, como o WakaTime conta (o que o Claude faz e o que você faz no painel). */
export type WakaToday = { seconds: number; text: string; goalHours: number };

const FRESH_MS = 3 * 60_000;
let today: { at: number; value: Promise<WakaToday | null> } | undefined;

/** "3 hrs 21 mins" (o que o `--today` imprime) em segundos. */
function parseToday(text: string): number {
  const take = (unit: string) => Number(new RegExp(`(\\d+)\\s*${unit}`).exec(text)?.[1] ?? 0);
  return take('hrs?') * 3600 + take('mins?') * 60 + take('secs?');
}

/** O total de hoje, perguntado ao wakatime-cli no máximo a cada três minutos; `null` sem ele. */
export async function wakatimeToday(): Promise<WakaToday | null> {
  if (today && Date.now() - today.at < FRESH_MS) return today.value;
  const value = (async () => {
    const cli = await findCli();
    if (!cli) return null;
    const { stdout } = await promisify(execFile)(cli, ['--today'], { timeout: 30_000 });
    const text = stdout.trim();
    return { seconds: parseToday(text), text, goalHours: WAKATIME_GOAL_HOURS };
  })();
  today = { at: Date.now(), value };
  // Falhou (sem rede, sem chave): tenta de novo na próxima, em vez de guardar o erro.
  value.catch(() => (today = undefined));
  return value;
}
