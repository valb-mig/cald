import { Bot } from 'lucide-react'
import { Claudinho } from '@/components/claudinho'
import { memberSeed } from '@/components/teams/model'
import type { TeamMember } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useAgents, type AgentNode } from './model'

/** O membro do time da conversa que este subagente é (pelo `subagent_type`), se for de um. */
export function useMember(node: Pick<AgentNode, 'type'>): TeamMember | undefined {
  return useAgents()?.team?.members.find((m) => m.key === node.type)
}

/** Como chamar o tipo do subagente: o nome (e o papel) do membro do time, ou o tipo de sempre. */
export const typeLabel = (node: Pick<AgentNode, 'type'>, member?: TeamMember) =>
  member ? (member.role ? `${member.name} · ${member.role}` : member.name) : node.type

/** A cara do subagente: o claudinho do membro do time (piscando enquanto trabalha) ou o robô de sempre. */
export function AgentFace({ node, member, size = 16, className }: { node: AgentNode; member?: TeamMember; size?: number; className?: string }) {
  if (!member) return <Bot className={cn('shrink-0 text-muted-foreground', className)} style={{ width: size, height: size }} />
  const working = node.status === 'running' || node.status === 'waiting'
  return <Claudinho seed={memberSeed(member)} size={size} state={working ? 'running' : undefined} className={className} />
}
