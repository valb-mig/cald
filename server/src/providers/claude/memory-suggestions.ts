import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DATA_DIR } from '../../config.ts';
import { HttpError } from '../../errors.ts';
import { readFields, setField, splitFrontmatter } from '../../frontmatter.ts';
import { addMemory, dropIndexLine, indexLinks, MEMORY_INDEX, memoryTarget, readMemoryFile } from './memory.ts';

/**
 * As memórias que o Claude quis guardar numa conversa do painel. Em vez de gravar na hora, o Write
 * (ou Edit) na pasta de memória é negado por um hook (ver panel-session.ts) e vira uma sugestão: o
 * Claude segue trabalhando, e você decide depois, pelo botão no topo do chat, se salva (do jeito que
 * veio ou editada) ou recusa. Salvar grava o arquivo e põe a linha no MEMORY.md.
 */

/** O recado que o Claude recebe no lugar do "arquivo gravado"; o app reconhece a ferramenta por ele. */
export const MEMORY_SUGGESTED =
  '[cald] Memória não gravada: ela virou uma sugestão no painel do cald, e o usuário decide lá se salva (talvez editada) ou recusa. ' +
  'Siga com o trabalho normalmente, sem tentar gravá-la por outro caminho e sem mexer no MEMORY.md por causa dela: salva, o cald põe a linha no índice. ' +
  'Se o usuário pedir uma mudança nela, grave de novo o mesmo arquivo, e a sugestão é trocada.';

/** O recado quando o Claude põe no índice a linha de uma memória que ainda é sugestão. */
export const INDEX_HELD =
  '[cald] MEMORY.md não mudado: ele passaria a citar uma memória que não existe (a que virou sugestão no painel). ' +
  'Se o usuário salvar a sugestão, o cald põe a linha no índice; não tente de novo.';

type Suggestion = {
  id: string;
  sessionId: string;
  /** A pasta do projeto em ~/.claude/projects e o arquivo da memória. */
  folder: string;
  file: string;
  /** O arquivo inteiro, como o Claude ia gravar. */
  text: string;
  /** A data do arquivo quando a sugestão chegou; null quando ela é uma memória nova. */
  base: number | null;
  createdAt: number;
  /** Recusada: fica um pouco para o Desfazer, e depois some. */
  dismissedAt?: number;
};

/** O que o app mostra de cada sugestão. */
export type MemorySuggestion = {
  id: string;
  file: string;
  name: string;
  description: string;
  type: string | null;
  body: string;
  /** Muda uma memória que já existe, em vez de criar uma. */
  update: boolean;
  createdAt: number;
};

const FILE = process.env.MEMORY_SUGGESTIONS_FILE ?? join(DATA_DIR, 'memory-suggestions.json');
const HOUR = 3_600_000;
// Sugestão esquecida (a conversa foi apagada, ninguém abriu) não fica para sempre.
const KEEP_DAYS = 30;

const stem = (file: string) => file.slice(0, -3);

function parse(text: string) {
  const parts = splitFrontmatter(text);
  const fields = readFields(parts?.head ?? []);
  return {
    head: parts?.head ?? null,
    name: fields.name ?? '',
    description: fields.description ?? '',
    type: fields['metadata.type'] ?? fields.type ?? null,
    body: parts ? parts.body : text,
  };
}

// "link-de-teste" → "Link de teste": o título da linha do índice, quando o nome é um slug.
const title = (name: string) => (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) ? name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) : name);

export class MemorySuggestionStore extends EventEmitter {
  private items: Suggestion[] = [];
  private writing = Promise.resolve();

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(FILE, 'utf8')) as { items?: Suggestion[] };
      if (Array.isArray(data.items)) this.items = data.items;
    } catch {
      // Primeiro uso ou arquivo ilegível: começa vazio.
    }
  }

  /** As sugestões ainda sem resposta de uma conversa, da mais antiga para a mais nova. */
  list(sessionId: string): MemorySuggestion[] {
    return this.items
      .filter((s) => s.sessionId === sessionId && !s.dismissedAt)
      .map((s) => {
        const p = parse(s.text);
        return { id: s.id, file: s.file, name: p.name || stem(s.file), description: p.description, type: p.type, body: p.body, update: s.base !== null, createdAt: s.createdAt };
      });
  }

  /**
   * Chamado pelo hook antes de um Write ou Edit: se ele grava uma memória, vira sugestão, e volta o
   * recado com que o hook nega a ferramenta; null deixa seguir. Um Edit muda a sugestão que já está
   * esperando para o mesmo arquivo ou, sem ela, a memória que existe; um Edit que não bate com nada
   * segue e falha sozinho. No índice, só é segurada a mudança que citaria uma memória que não existe:
   * o Claude costuma pôr a linha junto da memória, e ela viraria um link para o nada.
   */
  async propose(sessionId: string, tool: string, input: unknown): Promise<string | null> {
    const i = (input ?? {}) as Record<string, unknown>;
    if (typeof i.file_path !== 'string') return null;
    const target = memoryTarget(i.file_path);
    if (!target) return null;
    const index = target.file === MEMORY_INDEX;
    const waiting = index ? undefined : this.items.find((s) => s.sessionId === sessionId && !s.dismissedAt && s.folder === target.folder && s.file === target.file);
    const current = await readMemoryFile(target.folder, target.file);
    let text: string;
    if (tool === 'Write' && typeof i.content === 'string') {
      text = i.content;
    } else if (tool === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string' && i.old_string) {
      // A sugestão esperando primeiro; senão o arquivo, para o Edit não passar direto por ela.
      const old = i.old_string;
      const from = [waiting?.text, current?.text].find((t) => t?.includes(old));
      if (from === undefined) return null;
      const to = i.new_string;
      text = i.replace_all === true ? from.replaceAll(old, () => to) : from.replace(old, () => to);
    } else {
      return null;
    }
    if (index) {
      const before = indexLinks(current?.text ?? '');
      const added = [...indexLinks(text)].filter((f) => !before.has(f));
      const missing = await Promise.all(added.map((f) => readMemoryFile(target.folder, f).then((m) => m === null, () => false)));
      return missing.some(Boolean) ? INDEX_HELD : null;
    }
    if (waiting) {
      waiting.text = text;
      waiting.createdAt = Date.now();
    } else {
      this.items.push({ id: randomUUID().slice(0, 8), sessionId, ...target, text, base: current?.mtime ?? null, createdAt: Date.now() });
    }
    await this.save(sessionId);
    return MEMORY_SUGGESTED;
  }

  /** Salva a sugestão, do jeito que veio ou com a descrição e o texto que você mudou. */
  async accept(sessionId: string, id: string, edit: { description?: string; body?: string } = {}): Promise<void> {
    const s = this.find(sessionId, id);
    const p = parse(s.text);
    const name = p.name || stem(s.file);
    const description = (edit.description ?? p.description).replace(/\s+/g, ' ').trim();
    let text = s.text;
    if (edit.description !== undefined || edit.body !== undefined || p.head) {
      let head = p.head ?? [`name: ${JSON.stringify(name)}`];
      if (edit.description !== undefined) head = setField(head, 'description', description, true);
      // O que o Claude Code põe sozinho quando ele mesmo grava: a conversa de origem e quando mudou.
      head = setField(head, 'metadata.originSessionId', sessionId, true);
      head = setField(head, 'metadata.modified', new Date().toISOString(), true);
      text = `---\n${head.join('\n')}\n---\n\n${(edit.body ?? p.body).trim()}\n`;
    }
    await addMemory({ folder: s.folder, file: s.file, text, base: s.base, line: `- [${title(name)}](${s.file})${description ? ` — ${description}` : ''}` });
    this.items = this.items.filter((x) => x !== s);
    await this.save(sessionId);
  }

  /** Recusa: some da lista (o Desfazer a traz de volta) e leva junto a linha que o Claude tenha posto no índice. */
  async dismiss(sessionId: string, id: string): Promise<void> {
    const s = this.find(sessionId, id);
    s.dismissedAt = Date.now();
    await this.save(sessionId);
    if (s.base === null) await dropIndexLine(s.folder, s.file).catch(() => {});
  }

  async restore(sessionId: string, id: string): Promise<void> {
    const s = this.items.find((x) => x.sessionId === sessionId && x.id === id);
    if (!s) throw new HttpError(404, 'suggestion_not_found');
    delete s.dismissedAt;
    await this.save(sessionId);
  }

  /** A conversa ganhou id novo (o /clear, uma retomada): as sugestões vão com ela. */
  rekey(from: string, to: string): void {
    const moved = this.items.filter((s) => s.sessionId === from);
    for (const s of moved) s.sessionId = to;
    if (moved.length) void this.save(to);
  }

  private find(sessionId: string, id: string): Suggestion {
    const s = this.items.find((x) => x.sessionId === sessionId && x.id === id && !x.dismissedAt);
    if (!s) throw new HttpError(404, 'suggestion_not_found');
    return s;
  }

  // Gravação atômica e em fila, como em todos.ts. Aproveita para tirar as recusadas há mais de uma hora e as esquecidas.
  private save(sessionId: string): Promise<void> {
    const now = Date.now();
    this.items = this.items.filter((s) => (s.dismissedAt ? now - s.dismissedAt < HOUR : now - s.createdAt < KEEP_DAYS * 24 * HOUR));
    const snapshot = JSON.stringify({ items: this.items }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(FILE), { recursive: true });
      await writeFile(`${FILE}.tmp`, snapshot);
      await rename(`${FILE}.tmp`, FILE);
    });
    this.emit('change', sessionId);
    return this.writing;
  }
}
