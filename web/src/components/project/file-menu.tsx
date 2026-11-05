import { AppWindow, AtSign, Copy, FileText } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { mentionInChat, openViewer, type PanelProject } from '@/lib/project-panel'
import { isHtmlPath, showPrototype } from '@/lib/prototype'
import { splitPath } from './status'

/** Arquivo (ou pasta) e o ponto da tela (o do clique ou do dedo) onde o menu abre. */
export type FileMenuAt = { path: string; dir?: boolean; deleted?: boolean; x: number; y: number }

/** Mencionar no chat (um arquivo, pasta ou trecho), com o aviso quando a conversa não tem campo de mensagem. */
export function mention(path: string, at?: { dir?: boolean; lines?: [number, number] }): void {
  if (!mentionInChat(path, at)) toast('Esta conversa não tem onde escrever agora', { description: 'Aberta no PC: assuma a sessão para mencionar arquivos.' })
}

/** O menu de um arquivo da barra do projeto, e quem o abre (botão direito, ou o dedo segurado). */
export function useFileMenu(project: PanelProject) {
  const [at, setAt] = useState<FileMenuAt | null>(null)
  const [open, setOpen] = useState(false)
  const show = (next: FileMenuAt) => {
    setAt(next)
    setOpen(true)
  }

  const menu = (
    <DropdownMenu open={open && Boolean(at)} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: at?.x ?? 0, top: at?.y ?? 0 }} />
      </DropdownMenuTrigger>
      {/* Um pouco abaixo do dedo: ao soltar, ele não cai em cima de uma opção. O foco não volta para
          o gatilho invisível: mencionar o deixa no campo de mensagem. */}
      <DropdownMenuContent
        align="start"
        sideOffset={8}
        collisionPadding={8}
        className="w-auto max-w-72 min-w-52"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {at && (
          <>
            <DropdownMenuLabel className="truncate font-mono text-xs font-normal text-muted-foreground">
              {at.dir ? `${at.path}/` : splitPath(at.path).name}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => mention(at.path, { dir: at.dir })}>
              <AtSign /> Mencionar no chat
            </DropdownMenuItem>
            {!at.dir && !at.deleted && (
              <DropdownMenuItem onSelect={() => openViewer({ machine: project.machine, cwd: project.cwd, path: at.path })}>
                <FileText /> Abrir
              </DropdownMenuItem>
            )}
            {/* Um HTML também abre como página, num mini-navegador, que recarrega quando ele muda. */}
            {!at.dir && !at.deleted && isHtmlPath(at.path) && (
              <DropdownMenuItem onSelect={() => showPrototype({ machine: project.machine, cwd: project.cwd, path: at.path })}>
                <AppWindow /> Abrir como página
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() =>
                navigator.clipboard.writeText(at.path).then(
                  () => toast.success('Caminho copiado'),
                  () => toast.error('Não deu para copiar'),
                )
              }
            >
              <Copy /> Copiar caminho
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return { menu, show }
}
