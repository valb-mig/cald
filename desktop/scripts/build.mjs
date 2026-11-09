// Compila o processo principal e o preload do app do PC (desktop/src → desktop/dist).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const common = { absWorkingDir: root, bundle: true, platform: 'node', target: 'node24', external: ['electron'], sourcemap: 'linked', logLevel: 'warning' };

// O main é ESM (o Electron aceita); o preload roda no sandbox, que só aceita CommonJS. O
// electron-updater, que vai junto no main, é CommonJS e chama `require` nos módulos do Node: o
// banner dá a ele um `require` de verdade.
const banner = { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" };
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js', format: 'esm', banner });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', format: 'cjs' });
