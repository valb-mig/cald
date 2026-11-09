// Copia a node_modules do servidor para o app montado, antes de virar AppImage, .deb ou .pacman: o
// electron-builder descarta qualquer node_modules dos extraResources, mesmo com filtro.
const { cpSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  const from = join(__dirname, '..', 'stage', 'server', 'node_modules');
  const to = join(context.appOutDir, 'resources', 'server', 'node_modules');
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
};
