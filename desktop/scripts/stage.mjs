// Monta em desktop/stage o que vai junto no app (ver electron-builder.yml): o servidor com só as
// dependências de produção, numa node_modules plana, e o app web compilado.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const stage = join(repo, 'desktop', 'stage');
const run = (...args) => execFileSync('pnpm', args, { cwd: repo, stdio: 'inherit' });

rmSync(stage, { recursive: true, force: true });
run('--filter', 'web', 'build');
run('--filter', 'server', 'deploy', '--prod', '--config.node-linker=hoisted', join(stage, 'server'));
// O servidor roda o TypeScript direto (ver server/src/config.ts): o resto do pacote não precisa ir.
for (const extra of ['scripts', 'tsconfig.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  rmSync(join(stage, 'server', extra), { recursive: true, force: true });
}
