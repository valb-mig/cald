// A versão de um push na branch release (ver .github/workflows/desktop.yml): a seguinte à última
// tag v* no patch (v0.1.3 → 0.1.4). Para subir a minor ou a major, ponha a versão nova no
// desktop/package.json: maior que a última tag, ela vale. Grava a versão no desktop/package.json do
// checkout (o electron-builder e o app a leem dali, sem commit) e imprime `version=x.y.z`.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const pkgFile = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));

const parse = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? m.slice(1).map(Number) : null;
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
  .split('\n')
  .map(parse)
  .filter(Boolean)
  .sort(compare);
const last = tags.at(-1);
const floor = parse(pkg.version);
if (!floor) throw new Error(`Versão inválida no desktop/package.json: ${pkg.version}`);

const next = !last || compare(floor, last) > 0 ? floor : [last[0], last[1], last[2] + 1];
pkg.version = next.join('.');
writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`version=${pkg.version}`);
