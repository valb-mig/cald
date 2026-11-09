import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';

/**
 * O ambiente do seu shell de login, como o serviço do systemd faz com `zsh -lic` (ver
 * deploy/editr.service): aberto pelo menu do sistema, o app herda um PATH mínimo, e as conversas e
 * o terminal do painel precisam enxergar as mesmas ferramentas do seu terminal (node, java, gh…).
 */

const MARKER = '__EDITR_ENV__';
const TIMEOUT_MS = 10_000;

// Do shell que rodou o comando, não do seu ambiente.
const SHELL_ONLY = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);

// Postas pelo AppImage ao abrir o app: valem só para ele e atrapalhariam o que ele roda.
const APPIMAGE_VARS = ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD'];

/** O ambiente deste processo sem as variáveis do AppImage, nem as pastas dele no LD_LIBRARY_PATH. */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const appDir = env.APPDIR;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || APPIMAGE_VARS.includes(key)) continue;
    out[key] = value;
  }
  if (appDir && out.LD_LIBRARY_PATH) {
    const kept = out.LD_LIBRARY_PATH.split(':').filter((p) => p && !p.startsWith(appDir));
    if (kept.length) out.LD_LIBRARY_PATH = kept.join(':');
    else delete out.LD_LIBRARY_PATH;
  }
  return out;
}

/**
 * Roda o shell de login interativo e lê o `env` dele. O que o rc imprime (um fetch, um aviso) vem
 * antes da marca e fica de fora. Falhando, segue com o ambiente deste processo.
 */
export function loginShellEnv(): Promise<Record<string, string>> {
  const base = cleanEnv();
  const shell = base.SHELL || userInfo().shell || '/bin/bash';
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-lic', `printf '%s' ${MARKER}; env -0`],
      { env: base, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (_err, stdout) => {
        const at = stdout?.lastIndexOf(MARKER) ?? -1;
        if (at < 0) return resolve(base);
        const out = { ...base };
        for (const pair of stdout.slice(at + MARKER.length).split('\0')) {
          const eq = pair.indexOf('=');
          if (eq <= 0) continue;
          const key = pair.slice(0, eq);
          if (!SHELL_ONLY.has(key)) out[key] = pair.slice(eq + 1);
        }
        resolve(out);
      },
    );
  });
}
