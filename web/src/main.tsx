import '@/index.css'
import { ThemeProvider } from 'next-themes'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppCrash, ErrorBoundary } from '@/components/error-boundary'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import App from './App'

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
