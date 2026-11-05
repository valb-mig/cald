import '@/index.css'
import { ThemeProvider } from 'next-themes'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppCrash, ErrorBoundary } from '@/components/error-boundary'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { openComputerLink } from '@/lib/computer'
import App from './App'

// O aviso de aparelho novo abre o app em `/?computador=acesso`: o painel já começa aberto na seção,
// e o parâmetro sai do endereço antes das rotas (no celular, `/` redireciona e o perderia).
const rest = openComputerLink(location.href)
if (rest !== null) history.replaceState(history.state, '', rest)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider>
        <ErrorBoundary fallback={(error) => <AppCrash error={error} />}>
          <App />
        </ErrorBoundary>
        <Toaster position="top-center" />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
