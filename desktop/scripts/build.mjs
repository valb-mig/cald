// Compila o processo principal e o preload do app do PC (desktop/src → desktop/dist).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const common = { absWorkingDir: root, bundle: true, platform: 'node', target: 'node24', external: ['electron'], sourcemap: 'linked', logLevel: 'warning' };

// O main é ESM (o Electron aceita); o preload roda no sandbox, que só aceita CommonJS.
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js', format: 'esm' });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', format: 'cjs' });
