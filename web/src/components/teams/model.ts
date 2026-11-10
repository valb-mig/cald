import { nameOf } from '@/lib/claudinho'
import type { TeamInput, TeamMember } from '@/lib/types'

/**
 * O claudinho de cada membro do time sai do id dele, não da conversa: o Thor é o mesmo claudinho em
 * todas as conversas do time.
 */
export const memberSeed = (m: Pick<TeamMember, 'id'>) => `time:${m.id}`

/** Papéis prontos para começar um membro: o papel e as instruções, que dá para mudar depois. */
export const ROLES: { role: string; instructions: string }[] = [
  {
    role: 'Frontend',
    instructions:
      'Cuida da interface: componentes, estilos, acessibilidade e o layout no celular e no PC. Segue os padrões de UI que o projeto já usa e confere o resultado na tela quando der.',
  },
  {
    role: 'Backend',
    instructions:
      'Cuida de APIs, dados e regras de negócio. Mantém os contratos compatíveis com quem já os usa, trata os erros e não deixa segredo em log nem em código.',
  },
  {
    role: 'Testes',
    instructions:
      'Roda os testes, o lint e o build do projeto, investiga o que falhar e relata com o comando e o erro exatos. Só muda código de produto se for para corrigir o que o teste pegou.',
  },
  {
    role: 'Revisão',
    instructions:
      'Revisa as mudanças procurando bugs, regressões e falhas de segurança, apontando arquivo e linha de cada uma. Não edita nada: só relata.',
  },
]

/** Um membro novo, com id provisório (o PC guarda este) e o nome do claudinho dele. */
export function newMember(preset = ROLES[0]!): TeamInput['members'][number] & { id: string } {
  const id = crypto.randomUUID()
  return { id, name: nameOf(memberSeed({ id })), role: preset.role, instructions: preset.instructions }
}
