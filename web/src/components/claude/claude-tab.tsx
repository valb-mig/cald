import { useState } from 'react'
import { Segmented } from '@/components/settings-ui'
import type { PanelProject } from '@/lib/project-panel'
import { MemoryView } from './memory-view'
import { McpView, SkillsView } from './setup-view'

type Part = 'memory' | 'skills' | 'mcp'
const PARTS: Part[] = ['memory', 'skills', 'mcp']
const KEY = 'cr:claude-tab'

/**
 * A aba Claude da barra do projeto: o que o Claude Code carrega neste projeto. A memória dele, as
 * skills e os agentes que valem aqui (os do projeto primeiro) e os servidores MCP, com liga e desliga.
 * O de todos os projetos fica no painel Computador.
 */
export function ClaudeTab({ project }: { project: PanelProject }) {
  const [part, setPart] = useState<Part>(() => {
    const saved = localStorage.getItem(KEY) as Part | null
    return saved && PARTS.includes(saved) ? saved : 'memory'
  })
  const pick = (p: Part) => {
    setPart(p)
    localStorage.setItem(KEY, p)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 pt-1 pb-2">
        <Segmented
          value={part}
          onChange={pick}
          options={[
            { key: 'memory', label: 'Memória' },
            { key: 'skills', label: 'Skills' },
            { key: 'mcp', label: 'MCP' },
          ]}
        />
      </div>
      <div key={part} className="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {part === 'memory' ? (
          <MemoryView machine={project.machine} cwd={project.cwd} />
        ) : part === 'skills' ? (
          <SkillsView machine={project.machine} cwd={project.cwd} />
        ) : (
          <McpView machine={project.machine} cwd={project.cwd} />
        )}
      </div>
    </div>
  )
}
