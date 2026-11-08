import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { TeamSnapshot } from '../../teams.ts';

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
