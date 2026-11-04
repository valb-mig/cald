import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { discard, fileNameOf, saveAll, useUnsaved } from '@/lib/unsaved'

/**
 * A pergunta ao fechar abas com alteração não salva, como no VSCode: salvar e fechar, fechar sem
 * salvar ou deixar aberta. Se salvar falhar (o arquivo mudou no disco, por exemplo), a aba fica, e o
 * editor dela diz o que houve.
 */
export function UnsavedDialog() {
  const asking = useUnsaved((s) => s.asking)
  const [busy, setBusy] = useState(false)
  const keys = asking?.keys ?? []
  const names = keys.map(fileNameOf)

  const save = async () => {
    if (!asking) return
    setBusy(true)
    const ok = await saveAll(asking.keys)
    setBusy(false)
    asking.answer(ok)
  }

  return (
    <AlertDialog open={Boolean(asking)} onOpenChange={(open) => !open && asking?.answer(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">
            {names.length === 1 ? `Salvar as alterações em ${names[0]}?` : `Salvar as alterações em ${names.length} arquivos?`}
          </AlertDialogTitle>
          <AlertDialogDescription className="break-words">
            {names.length > 1 && `${names.join(', ')}. `}
            Fechando sem salvar, o que foi escrito se perde.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              discard(keys)
              asking?.answer(true)
            }}
          >
            Não salvar
          </Button>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              // A pergunta fica aberta até salvar: se não der, a aba não fecha.
              e.preventDefault()
              void save()
            }}
          >
            Salvar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
