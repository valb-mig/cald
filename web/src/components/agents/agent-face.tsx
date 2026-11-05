import { Claudinho } from '@/components/claudinho'
import type { TeamMember } from '@/lib/types'
import { agentSeed, agentState, type AgentNode } from './model'

/** A cara do subagente: o claudinho do membro do time ou, fora de um time, um claudinho só dele. */
export function AgentFace({ node, member, size = 16, className }: { node: AgentNode; member?: TeamMember; size?: number; className?: string }) {
  return <Claudinho seed={agentSeed(node, member)} size={size} state={agentState(node)} className={className} />
}
