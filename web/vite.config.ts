import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// `BACKEND`: outra instância do servidor (ex.: uma de teste em :7338).
const backend = process.env.BACKEND ?? 'http://127.0.0.1:7337'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Service worker próprio (src/sw.ts): cache do app e notificações.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'cald',
        short_name: 'cald',
        description: 'Controle pelo celular das sessões do Claude Code no PC',
        lang: 'pt-BR',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // Gira com o celular: na horizontal o app usa o layout compacto (ver `compact:` no index.css).
        orientation: 'any',
        background_color: '#0a0a0a',
        theme_color: '#0a0a0a',
        // "Compartilhar" do Android: prints, arquivos e textos de outros apps (ver SharePage e sw.ts).
        share_target: {
          action: '/compartilhar',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [{ name: 'files', accept: ['image/*', 'video/*', 'audio/*', 'application/pdf', 'text/*', '*/*'] }],
          },
        },
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // As cores de sintaxe (ver lib/highlight.ts) baixam só quando um arquivo é aberto: dezenas de
        // gramáticas no cache offline pesariam mais que o app inteiro.
        // Da Cascadia Code, os alfabetos que não aparecem em código também ficam de fora: baixam se surgirem.
        globIgnores: ['assets/hl/**', 'assets/cascadia-code-{arabic,braille,cyrillic,cyrillic-ext,greek,hebrew,vietnamese}-*'],
      },
    }),
  ],
  build: {
    rolldownOptions: {
      output: {
        // O Shiki e as gramáticas numa pasta própria, que o cache offline deixa de fora (acima).
        chunkFileNames: (chunk) =>
          chunk.moduleIds.some((id) => /[\\/](shiki|@shikijs)[\\/]/.test(id)) ? 'assets/hl/[name]-[hash].js' : 'assets/[name]-[hash].js',
      },
    },
  },
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })),
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    // Em dev o backend só aceita a própria origem; o proxy se apresenta como ele.
    proxy: {
      '/api': { target: backend, changeOrigin: true, headers: { origin: backend } },
      '/ws': { target: backend.replace('http', 'ws'), ws: true, changeOrigin: true, headers: { origin: backend } },
    },
  },
})
