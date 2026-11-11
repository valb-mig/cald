// Programas que, no começo de um `trecho`, fazem dele um comando para colar no terminal.
const PROGRAMS = new Set(
  (
    'npm npx pnpm pnpx yarn bun bunx deno node tsx corepack nvm fnm vite tsc oxlint eslint prettier vitest jest playwright ' +
    'python python3 pip pip3 uv uvx pipx poetry cargo rustup go make cmake java mvn gradle dotnet php composer ruby gem bundle ' +
    'git gh glab docker podman kubectl helm terraform systemctl journalctl loginctl tailscale ssh scp rsync curl wget ' +
    'ls cd cat less tail head grep rg find fd sed awk rm mv cp mkdir touch chmod chown ln sudo doas kill pkill killall ps ' +
    'tar unzip zip open xdg-open export source sh bash zsh fish echo env which man ' +
    'pacman yay paru apt apt-get dnf brew snap flatpak code claude psql mysql sqlite3 redis-cli ffmpeg tmux nvim vim'
  ).split(' '),
)

// Os blocos de código de terminal pelo nome da linguagem (```bash, ```console…).
const SHELLS = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'console', 'shellsession', 'terminal'])

/**
 * O comando de um bloco de código, se ele for de terminal: de shell (```bash, ```sh…), ou sem linguagem
 * com toda linha com cara de comando (ver `commandOf`; comentários com `#` passam). Com o `$ ` do prompt
 * (um ```console, com a saída junto), só as linhas dele, sem o `$ `. `null` se não é comando.
 */
export function blockCommandOf(code: string, lang?: string): string | null {
  const shell = lang !== undefined && SHELLS.has(lang.toLowerCase())
  if (lang && !shell) return null
  const lines = code.replace(/\s+$/, '').split('\n')
  const prompted = lines.filter((l) => /^\s*\$\s/.test(l)).map((l) => l.replace(/^\s*\$\s+/, ''))
  if (prompted.length) return prompted.join('\n')
  if (shell) return lines.join('\n').trim() ? lines.join('\n') : null
  const real = lines.filter((l) => l.trim() && !l.trim().startsWith('#'))
  return real.length && real.every((l) => commandOf(l)) ? lines.join('\n') : null
}

/**
 * O comando de um código inline, se ele for um (`npm i x`, `git push`, `$ ls -la`, `./deploy.sh --prod`),
 * sem o `$ ` do prompt; `null` para nomes soltos (`main`, `editr`, `pnpm`) e o que não é comando.
 */
export function commandOf(code: string): string | null {
  const text = code.trim()
  const prompted = /^\$\s+/.exec(text)
  if (prompted) return text.slice(prompted[0].length) || null
  if (text.includes('\n')) return null
  // Variáveis antes do programa: `PORT=7338 node src/index.ts`.
  const words = text.replace(/^(?:[A-Z_][A-Z\d_]*=\S*\s+)+/, '').split(/\s+/)
  if (words.length < 2) return null
  const program = words[0]!
  return PROGRAMS.has(program) || /^\.{0,2}\/\S/.test(program) ? text : null
}
