import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { HttpError } from './errors.ts';

/**
 * Times de agentes: subagentes seus, cada um com nome, papel, modelo, esforço e instruções, que a
 * conversa do painel recebe como os subagentes dela (no Claude Code, `agents` do SDK, ver
 * providers/claude/team.ts). O Claude da conversa coordena e delega a eles pela
 * ferramenta Agent, como faz com os subagentes de sempre. Cada conversa guarda uma cópia do time de
 * quando começou (ver meta.ts): editar ou apagar um time só vale para as conversas novas.
 */

/** Níveis de esforço de raciocínio que um membro pode pedir. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type TeamMember = {
  id: string;
  /** O `subagent_type` dele: sai do nome ("Thor" → "thor"), único no time. */
  key: string;
  name: string;
  /** O papel em poucas palavras: Frontend, Backend, Testes… */
  role: string;
  /** Sem modelo, ele usa o da conversa; sem esforço, o padrão do modelo. */
  model?: string;
  effort?: Effort;
  instructions: string;
};

export type Team = { id: string; name: string; members: TeamMember[]; updatedAt: number };
/** O time como a conversa guarda: o que vale para ela, sem a data da edição. */
export type TeamSnapshot = Pick<Team, 'id' | 'name' | 'members'>;
export type TeamInput = { id?: string; name: string; members: (Omit<TeamMember, 'id' | 'key'> & { id?: string })[] };
export type TrashedTeam = Team & { deletedAt: number };

export const MAX_MEMBERS = 8;
export const MAX_INSTRUCTIONS = 8_000;
const TRASH_DAYS = 30;

// Dado seu, como os TODOs: fica com os dados do app, não no cache.
const FILE = process.env.TEAMS_FILE ?? join(DATA_DIR, 'teams.json');

// Tipos que o Claude Code já tem: um membro com o mesmo nome taparia o de sempre.
const RESERVED = new Set(['general-purpose', 'explore', 'plan', 'statusline-setup', 'claude', 'output-style-setup']);

/** "Thor", "Atena QA" → "thor", "atena-qa": sem acento, só letras, números e hífen. */
function slug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agente'
  );
}

function clean(input: TeamInput, id: string): Team {
  const name = input.name.trim();
  if (!name) throw new HttpError(400, 'team_name_required');
  if (input.members.length > MAX_MEMBERS) throw new HttpError(400, 'team_too_big', { max: MAX_MEMBERS });
  const used = new Set<string>();
  const members = input.members.map((m): TeamMember => {
    const memberName = m.name.trim();
    if (!memberName) throw new HttpError(400, 'member_name_required');
    let key = slug(memberName);
    if (RESERVED.has(key)) key = `${key}-time`;
    for (let n = 2; used.has(key); n++) key = `${slug(memberName)}-${n}`;
    used.add(key);
    return {
      id: m.id || randomUUID(),
      key,
      name: memberName,
      role: m.role.trim(),
      model: m.model || undefined,
      effort: m.effort || undefined,
      instructions: m.instructions.trim().slice(0, MAX_INSTRUCTIONS),
    };
  });
  return { id, name, members, updatedAt: Date.now() };
}

/** Avisa `change` a cada gravação, venha do app ou do Claude (ver cald-mcp.ts). */
export class TeamStore extends EventEmitter {
  private teams: Team[] = [];
  private trash: TrashedTeam[] = [];
  private writing = Promise.resolve();

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(FILE, 'utf8')) as { teams?: Team[]; trash?: TrashedTeam[] };
      const valid = (t: Team) => t && typeof t.id === 'string' && Array.isArray(t.members);
      this.teams = Array.isArray(data.teams) ? data.teams.filter(valid) : [];
      const cutoff = Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000;
      this.trash = Array.isArray(data.trash) ? data.trash.filter((t) => valid(t) && t.deletedAt > cutoff) : [];
    } catch {
      // Primeiro uso ou arquivo ilegível: começa vazio.
    }
  }

  list(): Team[] {
    return this.teams;
  }

  get(id: string): Team {
    const team = this.teams.find((t) => t.id === id);
    if (!team) throw new HttpError(404, 'team_not_found');
    return team;
  }

  /** Cria (sem `id`) ou substitui um time. */
  async save(input: TeamInput): Promise<Team> {
    if (input.id) this.get(input.id);
    const team = clean(input, input.id ?? randomUUID());
    const others = this.teams.filter((t) => t.id !== team.id);
    this.teams = [...others, team].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    await this.persist();
    return team;
  }

  /**
   * Times vindos de outra máquina (ver config-sync.ts): entram com o mesmo id e a data da edição de lá,
   * por cima do daqui e da lixeira. Um que não passa na validação fica de fora e volta na lista.
   */
  async importTeams(list: Team[]): Promise<string[]> {
    const skipped: string[] = [];
    const incoming: Team[] = [];
    for (const t of list) {
      try {
        incoming.push({ ...clean(t, t.id), updatedAt: t.updatedAt });
      } catch {
        skipped.push(t.id);
      }
    }
    if (!incoming.length) return skipped;
    const ids = new Set(incoming.map((t) => t.id));
    this.teams = [...this.teams.filter((t) => !ids.has(t.id)), ...incoming].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    this.trash = this.trash.filter((t) => !ids.has(t.id));
    await this.persist();
    return skipped;
  }

  /** Os apagados, do mais recente ao mais antigo. */
  trashed(): TrashedTeam[] {
    return [...this.trash].sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /** Para a lixeira, de onde volta igual (o mesmo id, que um workspace pode apontar) por 30 dias. */
  async toTrash(id: string): Promise<void> {
    const team = this.get(id);
    this.teams = this.teams.filter((t) => t.id !== id);
    this.trash = [{ ...team, deletedAt: Date.now() }, ...this.trash];
    await this.persist();
  }

  async restore(id: string): Promise<Team> {
    const t = this.trash.find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'team_not_found');
    const { deletedAt: _deletedAt, ...team } = t;
    this.trash = this.trash.filter((x) => x.id !== id);
    this.teams = [...this.teams, team].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    await this.persist();
    return team;
  }

  /** Apaga de vez da lixeira. */
  async purge(id: string): Promise<void> {
    this.trash = this.trash.filter((x) => x.id !== id);
    await this.persist();
  }

  // Gravação atômica e em fila: um arquivo temporário renomeado por cima do atual.
  private persist(): Promise<void> {
    const snapshot = JSON.stringify({ teams: this.teams, trash: this.trash }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(FILE), { recursive: true });
      await writeFile(`${FILE}.tmp`, snapshot);
      await rename(`${FILE}.tmp`, FILE);
    });
    this.emit('change');
    return this.writing;
  }
}

export const snapshotOf = (team: Team): TeamSnapshot => ({ id: team.id, name: team.name, members: team.members });

/** O que a conversa fica sabendo do time, no fim do prompt de sistema. */
export function teamPrompt(team: TeamSnapshot): string {
  const lines = team.members.map((m) => {
    const extra = [m.model, m.effort && `esforço ${m.effort}`].filter(Boolean).join(', ');
    return `- \`${m.key}\`: ${m.name}${m.role ? `, ${m.role}` : ''}${extra ? ` (${extra})` : ''}`;
  });
  return [
    `# Seu time: ${team.name}`,
    'Nesta conversa você coordena um time de subagentes. Quando um pedido (ou parte dele) for da área de um deles, delegue com a ferramenta Agent, passando o `subagent_type` dele e tudo o que ele precisa saber; vários podem trabalhar ao mesmo tempo. O que for pequeno, ou fora da área de todos, faça você mesmo. Ao fim, junte o que cada um fez numa resposta só.',
    ...lines,
  ].join('\n');
}
