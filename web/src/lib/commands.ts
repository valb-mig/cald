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
