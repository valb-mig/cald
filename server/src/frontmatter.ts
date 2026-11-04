/**
 * O cabeçalho YAML (frontmatter) dos arquivos de memória, skills e agentes do Claude Code, sem
 * biblioteca de YAML: só o que esses arquivos usam. `chave: valor` com um nível de recuo (o
 * `metadata:` das memórias), valores entre aspas e os blocos `>` e `|` das descrições longas.
 */

type Line = { indent: number; key: string; raw: string; at: number; end: number };

/** Separa o cabeçalho (as linhas entre os dois `---`) do texto; sem cabeçalho, devolve null. */
export function splitFrontmatter(text: string): { head: string[]; body: string } | null {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  // Arquivo salvo no Windows: sem o \r, as linhas do cabeçalho não batem com nada.
  for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/\r$/, '');
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (close < 0) return null;
  return { head: lines.slice(1, close), body: lines.slice(close + 1).join('\n').replace(/^\n+/, '') };
}

// Cada chave com o seu recuo e até onde vai (um bloco `>` ou `|` ocupa as linhas mais recuadas que ela).
function keyLines(head: string[]): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < head.length; i++) {
    const m = /^(\s*)([\w-]+):(?:\s(.*))?$/.exec(head[i]);
    if (!m) continue;
    const indent = m[1].length;
    let end = i + 1;
    while (end < head.length && (head[end].trim() === '' || head[end].search(/\S/) > indent)) end++;
    out.push({ indent, key: m[2], raw: (m[3] ?? '').trim(), at: i, end });
  }
  return out;
}

function scalar(line: Line, head: string[]): string {
  const raw = line.raw;
  if (/^[>|][+-]?$/.test(raw)) {
    const block = head.slice(line.at + 1, line.end);
    const pad = Math.min(...block.filter((l) => l.trim()).map((l) => l.search(/\S/)));
    const text = block.map((l) => l.slice(pad));
    return (raw.startsWith('>') ? text.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ') : text.join('\n')).trim();
  }
  // Um valor comum também pode seguir nas linhas de baixo, mais recuadas: elas se juntam com espaço.
  const full = [raw, ...head.slice(line.at + 1, line.end).map((l) => l.trim())].filter(Boolean).join(' ');
  if (full.startsWith('"')) {
    try {
      return String(JSON.parse(full));
    } catch {
      return full.slice(1, -1);
    }
  }
  if (full.startsWith("'")) return full.slice(1, -1).replaceAll("''", "'");
  return full;
}

/**
 * Os campos do cabeçalho. Os de dentro de um bloco (`metadata:`) entram pelo caminho
 * (`metadata.type`); só um nível, que é o que esses arquivos usam.
 */
export function readFields(head: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  let parent: string | null = null;
  for (const line of keyLines(head)) {
    if (line.indent === 0) {
      parent = line.raw ? null : line.key;
      if (line.raw) fields[line.key] = scalar(line, head);
    } else if (parent && line.raw) {
      fields[`${parent}.${line.key}`] = scalar(line, head);
    }
  }
  return fields;
}

/**
 * Troca o valor de um campo do cabeçalho (`description` ou `metadata.modified`), preservando o
 * resto como estava. O valor vai entre aspas duplas, como o Claude Code grava. Campo que não existe
 * fica de fora, a não ser que `create` diga onde pô-lo (no fim do bloco de cima).
 */
export function setField(head: string[], path: string, value: string, create = false): string[] {
  const [first, second] = path.split('.');
  const lines = keyLines(head);
  const parent = second ? lines.find((l) => l.indent === 0 && l.key === first && !l.raw) : null;
  if (second && !parent) return head;
  const target = second
    ? lines.find((l) => l.at > parent!.at && l.at < parent!.end && l.key === second)
    : lines.find((l) => l.indent === 0 && l.key === first);
  const indent = second ? ' '.repeat(target?.indent ?? 2) : '';
  const line = `${indent}${second ?? first}: ${JSON.stringify(value)}`;
  if (target) return [...head.slice(0, target.at), line, ...head.slice(target.end)];
  if (!create) return head;
  const at = parent ? parent.end : head.length;
  return [...head.slice(0, at), line, ...head.slice(at)];
}
