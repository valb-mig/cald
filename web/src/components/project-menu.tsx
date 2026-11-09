import { BookText, ImageMinus, ImagePlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DetalhesSheet } from '@/components/project/detalhes'
import { api, errorMessage } from '@/lib/api'
import { blobToBase64 } from '@/lib/attachments'
import { WIDE_QUERY } from '@/lib/hooks'
import { projectKey } from '@/lib/project-groups'
import { bumpProjectIcon } from '@/lib/project-icons'
import { openProjectHub } from '@/lib/workbench'

/** Projeto e ponto da tela (o do clique ou do dedo) onde o menu abre. */
export type ProjectMenuAt = { machine: string; cwd: string; name: string; x: number; y: number }

type Info = { source: 'custom' | 'repo' | null; repo: boolean }

// Foto do celular cabe; o PC reduz para o quadrado da marca.
const MAX_BYTES = 20 * 1024 * 1024

/**
 * Menu de um projeto, no ponto onde foi pedido (botão direito ou dedo segurado no cabeçalho dele na
 * lista, na aba dele no celular ou na linha dele em Projetos): os detalhes dele (ver
 * components/project/detalhes.tsx), escolher a logo dele, quando o edit.r não acha uma no repositório ou a
 * achada não serve, e tirar a escolhida. A logo fica no PC do projeto, fora do repositório, e vale em
 * todos os aparelhos.
 */
export function ProjectMenu({ at, open, onOpenChange }: { at: ProjectMenuAt | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null)
  // O seletor de arquivo devolve depois que o menu fechou: o projeto fica guardado aqui.
  const target = useRef<ProjectMenuAt | null>(null)
  const key = at ? projectKey(at.machine, at.cwd) : ''
  const [info, setInfo] = useState<{ key: string; value: Info } | null>(null)
  const shown = info?.key === key ? info.value : null
  // A folha dos detalhes (no celular) sobrevive ao menu, que fecha ao escolher.
  const [detalhes, setDetalhes] = useState<ProjectMenuAt | null>(null)

  useEffect(() => {
    if (!open || !at) return
    let alive = true
    const done = (value: Info) => alive && setInfo({ key: projectKey(at.machine, at.cwd), value })
    // Servidor antigo, sem a rota: o menu oferece só escolher.
    api.projectIconInfo(at.machine, at.cwd).then(done, () => done({ source: null, repo: false }))
    return () => {
      alive = false
    }
  }, [open, at])

  const pick = async (file: File | undefined) => {
    const p = target.current
    if (!file || !p) return
    if (!file.type.startsWith('image/')) return void toast.error('Escolha uma imagem.')
    if (file.size > MAX_BYTES) return void toast.error('Imagem grande demais: até 20 MB.')
    try {
      await api.setProjectIcon(p.machine, p.cwd, await blobToBase64(file))
      bumpProjectIcon(p.machine, p.cwd)
      setInfo({ key: projectKey(p.machine, p.cwd), value: { source: 'custom', repo: info?.value.repo ?? false } })
      toast.success(`Logo de ${p.name} trocada`)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const remove = async (p: ProjectMenuAt, repo: boolean) => {
    try {
      await api.removeProjectIcon(p.machine, p.cwd)
      bumpProjectIcon(p.machine, p.cwd)
      setInfo({ key: projectKey(p.machine, p.cwd), value: { source: repo ? 'repo' : null, repo } })
      toast.success(repo ? `${p.name} voltou à logo do repositório` : `Logo de ${p.name} tirada`)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void pick(e.target.files?.[0])
          // Escolher o mesmo arquivo de novo também conta.
          e.target.value = ''
        }}
      />
      <DropdownMenu open={open && Boolean(at)} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: at?.x ?? 0, top: at?.y ?? 0 }} />
        </DropdownMenuTrigger>
        {/* Um pouco abaixo do dedo: ao soltar, ele não cai em cima de uma opção. */}
        <DropdownMenuContent
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className="w-auto max-w-72 min-w-56"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {at && (
            <>
              <DropdownMenuLabel className="truncate">{at.name}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => (matchMedia(WIDE_QUERY).matches ? openProjectHub(at.machine, at.cwd, 'detalhes') : setDetalhes(at))}>
                <BookText /> Detalhes
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  target.current = at
                  input.current?.click()
                }}
              >
                <ImagePlus /> {shown?.source ? 'Trocar a logo…' : 'Escolher uma logo…'}
              </DropdownMenuItem>
              {shown?.source === 'custom' && (
                <DropdownMenuItem onSelect={() => void remove(at, shown.repo)}>
                  <ImageMinus /> {shown.repo ? 'Voltar à logo do repositório' : 'Tirar a logo'}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                {shown?.source === 'repo' ? 'Hoje: a logo achada no repositório.' : 'Fica guardada no PC, fora do repositório.'}
              </DropdownMenuLabel>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <DetalhesSheet project={detalhes} onClose={() => setDetalhes(null)} />
    </>
  )
}
