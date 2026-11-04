# Contexto do Projeto

## O que é

O cald é um painel pessoal para controlar pelo celular as sessões do Claude Code que rodam no PC. O PC executa tudo (o Claude, o git, o shell); o celular, ou o navegador de outro computador, é o controle remoto, instalado como PWA e acessado só pela tailnet do dono. Começou em outubro de 2026 com o nome claude-remote e depois virou cald (o mascote é o "claudinho", uma gota com olhos).

## Stack

- **Monorepo pnpm** com dois pacotes, `server` e `web`, ambos em TypeScript; `pnpm check` confere os tipos dos dois.
- **Servidor:** Node.js 22.18 ou mais novo rodando o `.ts` direto, Fastify 5 com `@fastify/websocket` e `@fastify/static`, `sharp` para as miniaturas em WebP e `web-push` (VAPID) para as notificações.
- **Claude:** `@anthropic-ai/claude-agent-sdk`. O `query()` conduz as conversas do painel, e `listSessions`, `getSessionMessages`, `renameSession` e `deleteSession` cuidam do histórico. O binário `claude` usado é o que vem junto com o SDK, e as sessões abertas no PC são descobertas com `claude agents --json`.
- **Web:** React 19 + Vite 8, `vite-plugin-pwa` com service worker próprio (`src/sw.ts`, Workbox, `injectManifest`), Tailwind 4, shadcn/ui sobre Radix, zustand, wouter, react-markdown, Shiki (carregado sob demanda) e xterm.js 6 no terminal. Fontes Geist e Cascadia Code; lint com oxlint.
- **Serviços e ferramentas externas, todos rodando no PC:**
  - Tailscale: `tailscale serve` publica o painel em HTTPS, `tailscale status --json` diz quem é o dono do nó e quais são as outras máquinas, e o cabeçalho `Tailscale-User-Login` identifica quem acessa.
  - Web Push: a única coisa que sai da tailnet, criptografada, pelos serviços de push do Google ou da Apple.
  - Opcionais, conferidos a cada pedido (instalar não exige reiniciar): whisper.cpp para o ditado no Firefox (`deploy/install-whisper.sh`), Piper para a voz natural no PC (`deploy/install-piper.sh`), `wakatime-cli` para os heartbeats do seu tempo no painel, `gh` para os PRs e issues da inbox e da barra do projeto, e `parec` (PipeWire/PulseAudio) para o fundo que reage ao som do PC.
  - `python3` para a ponte do terminal e `systemd --user` para o serviço; `deploy/install.sh` monta tudo e instala o comando `cald` (`cald -link`, `cald -pin`).

## Arquitetura

**Um processo Node no PC.** `server/src/index.ts` sobe o Fastify só em `127.0.0.1:7337`; o `tailscale serve` é a única porta de entrada remota. O `guard.ts` confere o host, a origem, o login do Tailscale e, com PIN, o token. O servidor não tem etapa de build: o systemd roda `node src/index.ts` (via `zsh -lic`, para herdar o ambiente do usuário). Por isso o `tsconfig` liga `erasableSyntaxOnly` e `allowImportingTsExtensions`: os imports levam `.ts` e só vale sintaxe que o Node consegue simplesmente apagar, então nada de enums, parameter properties no construtor ou namespaces.

**Sessões.** O `Manager` (`manager.ts`) monta o catálogo com as conversas salvas em `~/.claude`, as sessões vivas no PC (terminal, VSCode) e as do painel. Cada conversa do painel tem um único dono: um processo headless do Claude Code dirigido por `PanelSession` (`panel-session.ts`), com uma fila de entrada que mantém o processo vivo entre turnos. As aprovações (`canUseTool`) e as perguntas (AskUserQuestion) viram cartões no app. As sessões abertas no PC são acompanhadas por `claude agents --json` com `fs.watch` e um polling de reserva. Não há botão de assumir: mandar uma mensagem numa delas pelo app encerra a do terminal, se estiver ociosa, e a retoma no painel (`takeOver`, chamado pela fila do app); **Liberar** a devolve ao `claude --resume`. Cada mensagem sua mostra por onde entrou, de que máquina e quando (`origins.ts`): terminal e VSCode saem do `entrypoint` e da hora do transcript; do app, o cald dá o UUID à mensagem (o CLI grava com o que recebe) e guarda o aparelho, achado pelo IP do `X-Forwarded-For` no `tailscale status`, em `~/.local/share/cald/origins.jsonl`.

**Tempo real.** O WebSocket `/ws` manda `snapshot`, `event`, `delta` e `catalog`. Cada evento tem um `seq`, e o app reconecta pedindo a partir do último que viu (`web/src/lib/store.ts`). Mensagens escritas sem conexão ficam numa fila no IndexedDB (`lib/outbox.ts`) e saem sozinhas quando a conexão volta, sem repetir o turno.

**Web.** O build vai para `web/dist`, com `.br` e `.gz` ao lado de cada arquivo. O servidor lê de lá a cada requisição, então um `pnpm build` não exige reiniciar o serviço (mudar o servidor exige). No celular é uma tela por vez, com as abas embaixo. No PC (a partir de 1024 px, ou 768 px com mouse) o app vira uma casca no jeito do VSCode: a alça e a lista de conversas à esquerda, grupos de abas lado a lado no meio (conversas, arquivos, diffs, inbox, workspaces), a barra do projeto à direita (arquivos, git, PRs e issues, TODO), a barra de status no pé e o painel de baixo.

**Várias máquinas.** Cada servidor pergunta ao Tailscale quais nós do mesmo dono respondem `/api/health` como cald (`machines.ts`). Não há central: o app fala direto com cada máquina, e cada conversa pertence a uma delas. As notificações das outras máquinas são repassadas (`/api/push/relay`) à máquina de onde o app foi instalado, a única em que o celular se inscreve.

**PIN** (`pin.ts`, `guard.ts`, `web/src/lib/lock.ts`). É definido no PC com `cald -pin`, e só o hash scrypt fica em `~/.local/state/cald/pin.json`. Acertar dá um token por máquina, exigido em toda rota da API e no WebSocket (`Authorization: Bearer` ou `?t=`); depois de 5 erros seguidos a espera começa em 30 s e dobra até 15 min. No app, os tokens ficam na sessionStorage (recarregar segue destravado, fechar o app trava), e o PIN digitado uma vez destrava todas as máquinas que usam o mesmo. O app também trava sozinho por inatividade ou ao ir para o fundo, com o tempo ajustável por aparelho.

**Terminal no painel de baixo.** O painel de baixo existe só no PC e abre pela barra de status. Ele tem duas abas: os comandos que o Claude rodou na conversa em foco e o terminal do PC.
- O servidor não usa node-pty. `terminal.ts` abre `python3 terminal-pty.py`, que faz `pty.fork()` do shell de login do usuário. O fd 0 leva o que se digita, o fd 1 traz a saída crua (que segue binária pelo WebSocket `/ws/terminal` até o xterm.js), e o fd 3 é o canal de controle: `"colunas linhas"` redimensiona, e `"w"` manda SIGWINCH ao programa em primeiro plano para ele se redesenhar.
- Cada shell vive no servidor, num mapa indexado pelo id da aba, independente da conexão. Se o WebSocket cai (página recarregada, app travado, rede piscando), a aba volta pelo mesmo id dizendo até que byte já viu (`since`) e recebe o resto de um buffer de 1 MiB. Sem nenhum aparelho ligado por 24 h, o shell é encerrado. O limite é de 32 terminais, e reiniciar o cald encerra todos.
- No zsh, o `ZDOTDIR` aponta para `server/src/shell/zsh`, cujos arquivos carregam os do usuário e, por último, o `cald.zsh`. Ali cada comando vira um bloco marcado com OSC 133 (A cabeçalho, B entrada, C rodou, D;n código de saída), com a pasta e a branch no cabeçalho e o prompt `›` no laranja do Claude; o OSC 7 informa a pasta atual, que dá nome à aba. Outros shells abrem como são.
- No app, as abas ficam em `web/src/lib/terminals.ts`, salvas no aparelho, e não seguem a conversa em foco; o `+` abre um shell na pasta do projeto ou da conversa em foco.

**Dados no PC.** `~/.local/share/cald` guarda o que precisa durar (`activity.json`, workspaces, times, Whisper, Piper); `~/.local/state/cald` guarda o estado (`meta.json` com fixadas e bifurcações, `push.json`, `pin.json`); `~/.cache/cald` guarda os anexos enviados e as conversas a reabrir depois de uma atualização. O histórico das conversas é o do próprio Claude Code, em `~/.claude`.

**Desenvolvimento.** `pnpm dev:web` sobe o Vite com proxy para o serviço na 7337 (ou para outra instância via `BACKEND`). Para mexer no servidor sem derrubar o serviço, roda-se outra instância com `PORT=7338 pnpm dev`, que pode aparecer no app via `EXTRA_MACHINES`. Não há testes automatizados; `server/scripts/poc-client.ts` é um cliente de linha de comando que faz o papel do celular.

## Decisões importantes

- **Ponte em Python para o pty, em vez de node-pty** — evita módulo nativo num servidor que roda sem build e sem compilar nada.
- **Servidor só em 127.0.0.1, atrás do `tailscale serve`** — dispensa conta e senha: a tailnet garante que só aparelhos do dono chegam, com HTTPS, e o login do Tailscale é conferido em cada pedido.
- **PIN conferido no servidor, com só o hash no PC** — o Tailscale não protege do celular desbloqueado na mão de outra pessoa, e conferir no servidor faz até quem chama a API direto, sem o app, esbarrar no PIN.
- **TypeScript sem build no servidor** — o Node roda o `.ts` direto, o que simplifica o serviço e a atualização; o preço é a regra de usar só sintaxe apagável.
- **Binário `claude` do próprio Agent SDK** — garante a mesma versão de protocolo do `query()`. As variáveis `CLAUDECODE*` herdadas (servidor iniciado de dentro do VSCode, por exemplo) são tiradas do ambiente do processo filho para ele não se identificar errado.
- **Serviço via `zsh -lic`** — o Claude aberto pelo celular precisa enxergar o mesmo PATH e as mesmas ferramentas do terminal.
- **Um dono por sessão, e a sessão do PC só é encerrada ociosa e no terminal** — dois processos nunca conduzem a mesma conversa ao mesmo tempo. Sem botão de assumir: enviar pelo app já é a intenção, e a linha de origem de cada mensagem mostra o caminho da conversa entre os aparelhos.
- **Títulos gravados no Claude Code (`renameSession`)** — aparecem também no `/resume` do terminal e no VSCode; o `meta.json` guarda só o que é exclusivo do painel.
- **Histórico de uso num arquivo próprio (`activity.json`)** — o Claude Code apaga os transcripts depois de ~30 dias, e o grid do ano não pode perder os dias antigos.
- **Whisper e Piper locais e opcionais** — o áudio não sai do PC e tudo funciona sem internet. O Piper existe porque, no Linux, a voz do navegador é a do espeak, robótica.
- **Nenhum botão de descartar alterações no git** — é a única ação que não teria volta.
- **Atualização pelo próprio app, com travas** — recusa com mudança local, `main` divergente ou conversa trabalhando, e reabre as conversas do painel depois do reinício.
- **Custo de pintura sob controle** — Shiki e cada gramática só baixam quando usados (e ficam fora do cache offline); os fundos ASCII usam um atlas de glifos, repintam só as células que mudaram e param fora da tela.
- **Tudo em pt-BR** — comentários de código, textos da UI, README e mensagens de commit. Os commits seguem `tipo(escopo): descrição` em português, cada feature leva um commit `docs:` próprio atualizando o README (que é o manual completo do app), e o trabalho vai em branches `valb-mig/feat-*` que entram na `main` por PR.

## Estado atual

O painel está completo e em uso diário (cerca de 250 commits desde 17/10/2026): chat com aprovações, perguntas, subagentes, bifurcação, fila offline, anexos, ditado e leitura em voz alta; times de agentes e workspaces; inbox (GitHub, git, TODOs e conversas esperando você); a salinha em SVG; o mapa mental; o início com os limites do plano e o histórico de uso; explorador de arquivos e git; abas e split no PC; notificações, sons e fundos animados; várias máquinas; e atualização pelo próprio app.

A branch atual é `valb-mig/feat-pin`, com o PIN (servidor, `cald -pin`, tela de bloqueio e README) ainda fora da `main`. Além disso, a árvore de trabalho tem mudanças não commitadas:
- **Voz do Piper no PC:** `server/src/speak.ts`, as rotas `/api/speak`, `deploy/install-piper.sh` e a leitura em `web/src/lib/speech.ts`, que gera cada frase no PC enquanto a anterior toca e volta para a voz do navegador se o Piper falhar.
- **Véu do fundo:** o véu que deixa o texto legível sobre a cena animada saiu do chat para `web/src/components/wallpaper/veil.tsx` e passou a valer também na inbox aberta numa aba do PC, que ganhou ainda um filtro por período. Deixou de ser uma faixa esfumaçada no meio: agora escurece a janela inteira por dentro, por igual, com a força em `dim` (prefs do fundo em `web/src/lib/wallpaper.ts`, slider "Escurecer" no painel Computador, só para cenas que pedem véu, como a foto).
- **Terminal com abas e persistência:** `server/src/terminal.ts` (shells por id, replay de 1 MiB, TTL de 24 h), o redesenho na ponte Python, o OSC 7 no `cald.zsh`, `web/src/lib/terminals.ts`, `status-bar.tsx` e `terminal.tsx`. A tela de bloqueio agora puxa o foco, para os dígitos do PIN não irem parar no terminal.
- O README já descreve o Piper, as abas do terminal e as rotas novas.

Em paralelo, o worktree `.claude/worktrees/feat-worktrees` (branch `valb-mig/feat-worktrees`, também com trabalho não commitado) leva conversas para git worktrees próprios, com **Trazer** (merge na branch de origem) e remoção do worktree.
