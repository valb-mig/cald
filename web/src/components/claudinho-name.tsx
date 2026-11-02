import { useState } from 'react'
import { toast } from 'sonner'
import { Claudinho } from '@/components/claudinho'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api, errorMessage } from '@/lib/api'
import { nameOf } from '@/lib/claudinho'

type Named = { sessionId: string; claudinhoName?: string }

/** O formulário: só monta com o diálogo aberto, então o campo já nasce com o nome de agora. */
function NameForm({ session, onDone }: { session: Named; onDone: () => void }) {
  const [name, setName] = useState(session.claudinhoName ?? '')
  const [busy, setBusy] = useState(false)
  const drawn = nameOf(session.sessionId)

  const save = async (value: string | null) => {
    setBusy(true)
    try {
      await api.claudinhoName(session.sessionId, value?.trim() || null)
      onDone()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader className="items-center text-center">
        <Claudinho seed={session.sessionId} size={56} className="mb-1" />
        <DialogTitle>Nome do claudinho</DialogTitle>
        <DialogDescription>Vale para esta conversa, no celular e no PC. Em branco, volta a se chamar {drawn}.</DialogDescription>
      </DialogHeader>
      <form
        id="claudinho-name"
        onSubmit={(e) => {
          e.preventDefault()
          void save(name)
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={drawn} maxLength={24} autoFocus aria-label="Nome" />
      </form>
      <DialogFooter>
        {session.claudinhoName && (
          <Button variant="ghost" disabled={busy} onClick={() => void save(null)}>
            Voltar a {drawn}
          </Button>
        )}
        <Button type="submit" form="claudinho-name" disabled={busy}>
          Salvar
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * Trocar o nome do claudinho de uma conversa (pelo botão direito na lista, na aba ou no claudinho do
 * cabeçalho). Vazio, ou "Voltar a…", e ele volta ao nome que o app deu. Fica no PC, como o fixar: vale
 * em todos os aparelhos.
 */
export function ClaudinhoNameDialog({
  session,
  open,
  onOpenChange,
}: {
  /** A conversa; fica com a última enquanto o diálogo fecha, para não esvaziar na animação. */
  session: Named | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open && Boolean(session)} onOpenChange={onOpenChange}>
      <DialogContent>{session && <NameForm key={session.sessionId} session={session} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  )
}
