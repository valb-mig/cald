import { TriangleAlert } from 'lucide-react'
import { Component, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

type Props = { children: ReactNode; fallback: (error: Error, reset: () => void) => ReactNode }

/**
 * Segura o erro de desenho de um pedaço da tela, para ele não levar o app junto: sem isto o React
 * desmonta tudo, e sobra só o fundo. O caso típico é o front recém-compilado conversando com o
 * servidor ainda não reiniciado, que não manda um campo que o front novo já espera.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  reset = () => this.setState({ error: null })

  render() {
    return this.state.error ? this.props.fallback(this.state.error, this.reset) : this.props.children
  }
}

/** O aviso no lugar do que quebrou: o que aconteceu, a mensagem do erro e as saídas. */
export function Crash({ title, error, actions }: { title: string; error: Error; actions: ReactNode }) {
  return (
    <div role="alert" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <TriangleAlert className="size-5 text-amber-600 dark:text-amber-400" />
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="max-w-md font-mono text-xs break-words text-muted-foreground">{error.message}</p>
      <div className="flex flex-wrap justify-center gap-2">{actions}</div>
    </div>
  )
}

/** A raiz do app: com a tela inteira quebrada, o que resta é recarregar. */
export function AppCrash({ error }: { error: Error }) {
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <Crash
        title="O app não conseguiu abrir esta tela"
        error={error}
        actions={
          <Button size="sm" variant="outline" onClick={() => location.reload()}>
            Recarregar
          </Button>
        }
      />
    </div>
  )
}
