import type { AgentDefinition, EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { HttpError } from './errors.ts';

/**
 * Times de agentes: subagentes seus, cada um com nome, papel, modelo, esforço e instruções, que a
 * conversa do painel recebe como `agents` do SDK. O Claude da conversa coordena e delega a eles pela
 * ferramenta Agent, como faz com os subagentes de sempre. Cada conversa guarda uma cópia do time de
 * quando começou (ver meta.ts): editar ou apagar um time só vale para as conversas novas.
 */

export type TeamMember = {
  id: string;
  /** O `subagent_type` dele: sai do nome ("Thor" → "thor"), único no time. */
  key: string;
  name: string;
  /** O papel em poucas palavras: Frontend, Backend, Testes… */
  role: string;
  /** Sem modelo, ele usa o da conversa; sem esforço, o padrão do modelo. */
  model?: string;
  effort?: EffortLevel;
  instructions: string;
};

export type Team = { id: string; name: string; members: TeamMember[]; updatedAt: number };
/** O time como a conversa guarda: o que vale para ela, sem a data da edição. */
export type TeamSnapshot = Pick<Team, 'id' | 'name' | 'members'>;
export type TeamInput = { id?: string; name: string; members: (Omit<TeamMember, 'id' | 'key'> & { id?: string })[] };

export const MAX_MEMBERS = 8;
export const MAX_INSTRUCTIONS = 8_000;

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
  private writing = Promise.resolve();

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(FILE, 'utf8')) as { teams?: Team[] };
      this.teams = Array.isArray(data.teams) ? data.teams.filter((t) => t && typeof t.id === 'string' && Array.isArray(t.members)) : [];
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

  async remove(id: string): Promise<void> {
    this.teams = this.teams.filter((t) => t.id !== id);
    await this.persist();
  }

  // Gravação atômica e em fila: um arquivo temporário renomeado por cima do atual.
  private persist(): Promise<void> {
    const snapshot = JSON.stringify({ teams: this.teams }, null, 2);
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

/** Os membros como subagentes do SDK: o nome e o papel dizem ao Claude quando chamar cada um. */
export function agentsOf(team: TeamSnapshot): Record<string, AgentDefinition> {
  return Object.fromEntries(
    team.members.map((m) => {
      const role = m.role ? `, ${m.role}` : '';
      const brief = m.instructions.split('\n').find((l) => l.trim())?.trim() ?? '';
      return [
        m.key,
        {
          description: `${m.name}${role} do time "${team.name}". ${brief}`.trim().slice(0, 600),
          prompt: [
            `Você é ${m.name}${role} no time "${team.name}", chamado pelo Claude que coordena esta conversa.`,
            m.instructions,
            'Faça só o que foi delegado a você e termine com um relatório curto do que fez, do que mudou e do que ficou pendente.',
          ]
            .filter(Boolean)
            .join('\n\n'),
          model: m.model,
          effort: m.effort,
        },
      ];
    }),
  );
}

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
