import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** De onde uma conversa bifurcou, e em que ponto do log da origem ela foi cortada. */
export type Fork = { from: string; at?: string };

/**
 * Metadados só do painel; títulos ficam no próprio Claude Code (renameSession). `names`: o nome que
 * você deu ao claudinho de uma conversa; sem ele, vale o sorteado pelo app.
 */
type Meta = {
  pinned: string[];
  forks: Record<string, Fork>;
  names: Record<string, string>;
  /** O claudinho que a conversa veste: o id de onde ele vem, quando ela continua outra (um /clear). */
  looks: Record<string, string>;
  /** Conversas esvaziadas por um /clear, com a que continuou no lugar delas: saem da lista do painel. */
  cleared: Record<string, string>;
};

const FILE = process.env.META_FILE ?? join(homedir(), '.local', 'state', 'claude-remote', 'meta.json');

export class MetaStore {
  private meta: Meta = { pinned: [], forks: {}, names: {}, looks: {}, cleared: {} };
  private writing = Promise.resolve();

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(FILE, 'utf8')) as Partial<Meta>;
      this.meta = {
        pinned: Array.isArray(data.pinned) ? data.pinned.filter((p) => typeof p === 'string') : [],
        forks: data.forks && typeof data.forks === 'object' ? data.forks : {},
        names: data.names && typeof data.names === 'object' ? data.names : {},
        looks: data.looks && typeof data.looks === 'object' ? data.looks : {},
        cleared: data.cleared && typeof data.cleared === 'object' ? data.cleared : {},
      };
    } catch {
      // Primeiro uso ou arquivo ilegível: começa vazio.
    }
  }

  isPinned(sessionId: string): boolean {
    return this.meta.pinned.includes(sessionId);
  }

  /**
   * De onde esta conversa bifurcou. Fica gravado porque o vínculo precisa durar mais que o processo:
   * é por ele que o painel mostra o histórico herdado depois que a bifurcação é fechada.
   */
  forkOf(sessionId: string): Fork | undefined {
    return this.meta.forks[sessionId];
  }

  async setFork(sessionId: string, fork: Fork): Promise<void> {
    this.meta = { ...this.meta, forks: { ...this.meta.forks, [sessionId]: fork } };
    await this.save();
  }

  /** O nome que você deu ao claudinho da conversa, se deu. */
  nameOf(sessionId: string): string | undefined {
    return this.meta.names[sessionId];
  }

  /** `null` (ou vazio) volta ao nome sorteado. */
  async setName(sessionId: string, name: string | null): Promise<void> {
    const { [sessionId]: _old, ...names } = this.meta.names;
    const clean = name?.trim();
    this.meta = { ...this.meta, names: clean ? { ...names, [sessionId]: clean } : names };
    await this.save();
  }

  /** O id de onde vem o claudinho da conversa (a aparência e o nome sorteado); sem herança, o dela. */
  lookOf(sessionId: string): string | undefined {
    return this.meta.looks[sessionId];
  }

  /**
   * `to` continua `from` (o /clear, uma sessão retomada com id novo): veste o mesmo claudinho e leva o
   * nome que você deu a ele. O estado muda na hora; só a gravação fica para depois.
   */
  inherit(to: string, from: string): Promise<void> {
    const look = this.meta.looks[from] ?? from;
    const name = this.meta.names[from];
    this.meta = {
      ...this.meta,
      looks: { ...this.meta.looks, [to]: look },
      names: name ? { ...this.meta.names, [to]: name } : this.meta.names,
    };
    return this.save();
  }

  /** `from` foi esvaziada por um /clear e continua em `to`: não aparece mais na lista (o arquivo fica no PC). */
  setCleared(from: string, to: string): Promise<void> {
    this.meta = { ...this.meta, cleared: { ...this.meta.cleared, [from]: to } };
    return this.save();
  }

  isCleared(sessionId: string): boolean {
    return sessionId in this.meta.cleared;
  }

  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    const others = this.meta.pinned.filter((id) => id !== sessionId);
    this.meta = { ...this.meta, pinned: pinned ? [...others, sessionId] : others };
    await this.save();
  }

  // Gravação atômica e em fila: um arquivo temporário renomeado por cima do atual.
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.meta, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(FILE), { recursive: true });
      await writeFile(`${FILE}.tmp`, snapshot);
      await rename(`${FILE}.tmp`, FILE);
    });
    return this.writing;
  }
}
