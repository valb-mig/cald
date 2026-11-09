<div align="center">

<img src="web/public/pwa-192.png" width="96" alt="Logo do edit.r: um “.r” preto num quadrado arredondado branco">

# edit.r

</div>

Painel pessoal para controlar pelo celular as sessões do Claude Code que rodam no PC. O PC executa tudo; o celular é o controle remoto, acessado pela rede Tailscale.

O nome é uma homenagem ao edit.r, o primeiro editor de código do autor. Onde o nome é técnico (o comando, o serviço, as pastas de dados, o MCP e o prefixo das habilidades), ele é `editr`.

Estado atual: backend e frontend funcionando; o PWA é React + Vite + shadcn/ui.

## Instalar na sua máquina

O PC fica ligado com o servidor rodando como serviço, e o celular acessa pela sua rede Tailscale. Não há nuvem no meio: só aparelhos da sua tailnet chegam ao painel, e um PIN opcional protege do celular desbloqueado na mão de outra pessoa (ver [PIN](#pin)). A exceção são as notificações, que passam criptografadas pelo serviço de push do Google (ou da Apple, no iPhone).

### Requisitos

- **Linux com systemd.** O servidor roda como serviço de usuário, e o quadro do computador lê CPU e memória de `/proc`.
- **Node.js 22.18 ou mais novo.** O servidor roda o TypeScript direto, sem etapa de build (testado no 26).
- **pnpm:** `npm install -g pnpm`.
- **Claude Code** instalado e logado: rode `claude` uma vez e faça o login. O painel usa as mesmas credenciais e o mesmo histórico de `~/.claude`.
- **Tailscale** no PC e no celular, logados na mesma conta.
- **ripgrep** (`rg`), opcional: é o que busca texto nos arquivos pela barra do projeto (pacote `ripgrep` na maioria das distros).

### Jeito rápido: o instalador

Com os requisitos acima prontos (e o Tailscale com **MagicDNS** e **HTTPS Certificates** ligados no [painel de DNS](https://login.tailscale.com/admin/dns)):

```sh
git clone -b release https://github.com/valb-mig/editr.git ~/Projects/editr
cd ~/Projects/editr
./deploy/install.sh
```

O script compila o app, sobe o serviço systemd (ajustando o caminho, o shell e o Node à sua máquina), publica na tailnet com `tailscale serve` e instala o comando `editr`. No fim, ele imprime o **link de acesso remoto** que o celular vai abrir. Depois, de qualquer terminal:

```sh
editr -link      # mostra o link de acesso remoto da tailnet; `editr -link off` desliga, `editr -link on` liga de novo
editr -pin       # define (ou troca) o PIN pedido ao abrir o painel; `editr -pin off` remove
```

Para não decorar o link: de qualquer aparelho da tailnet, digitar só o nome da máquina no navegador (`valb`, que vira `http://valb` pelo MagicDNS) leva ao endereço completo. O instalador publica esse atalho em http, na porta 80 (`tailscale serve --bg --http=80 7337`), e o servidor só redireciona dali para o https, sem servir nada: sem https, o navegador não deixa instalar o app, notificar nem usar o microfone. No próprio PC o atalho pode não valer: lá o nome da máquina resolve para os endereços locais dela, e o que estiver na porta 80 da rede local (um nginx de outro projeto, por exemplo) responde antes; no PC, use `http://localhost:7337` ou o app instalado.

O instalador é idempotente, então pode rodar de novo sem medo. Se preferir entender cada etapa, siga os passos manuais abaixo.

### App do PC

No PC, o edit.r também roda como app (Electron), fora do navegador e sem endereço para lembrar: a janela, o ícone na bandeja e o servidor, tudo junto.

- **Instalar:** baixe dos [Releases](https://github.com/valb-mig/editr/releases/latest) o `editr-x86_64.AppImage` (torne executável com `chmod +x` e abra), o `.deb` ou o `.pacman` do Arch. Para gerar a partir do repositório: `pnpm install && pnpm desktop:dist`, que deixa os três em `desktop/release/`. O app já traz o Node e o servidor; continuam valendo o Claude Code logado, o `python3` (o terminal do painel) e, para o celular, o Tailscale.
- **O servidor vem junto.** Se já há um edit.r na porta 7337 (o serviço do instalador acima), o app só abre a janela nele; senão, sobe o que vem dentro dele, com o ambiente do seu shell de login, como o serviço. Se o serviço sai do ar de vez (parado, ou desistindo de subir), o app assume a porta; no reinício da atualização, ele só espera o serviço voltar.
- **Fechar a janela deixa o edit.r na bandeja**, com o servidor de pé para o celular. Ctrl+Q ou **Sair**, na bandeja, encerram de verdade; com o servidor do próprio app, o celular perde o acesso até você abrir de novo. Na primeira abertura, o app liga **Iniciar com o sistema** (desliga na bandeja) e, daí em diante, sobe só na bandeja a cada login.
- **Notificações do sistema:** o Electron não tem Web Push, então o app recebe os avisos direto do servidor (os mesmos do celular, inclusive os das suas outras máquinas) e mostra como notificação do PC. **Computador → Notificações** escolhe o que avisa; com a janela na frente, não avisa.
- **Ditado:** no app, é sempre o do Whisper (ver [Ditado no Firefox](#ditado-no-firefox-whisper)).
- **Link do celular**, na bandeja, abre o **Computador → Acesso**, com o QR.
- **Abrir numa tela, de fora:** `editr --open=/s/<id>` (ou o AppImage com o mesmo argumento) abre a conversa no app, que já estando aberto só traz a janela e vai até ela. Serve para a barra do sistema ou um atalho; um `--hidden` repetido, de um autostart rodado de novo, não abre a janela.
- **Atualizar:** o AppImage se atualiza sozinho. Ele procura a versão nova nos Releases ao abrir e a cada 6 h, baixa em segundo plano e instala quando você sai do app. Para instalar na hora, use **Reiniciar para atualizar**, na bandeja ou no menu do app (Alt): o app encerra o servidor com calma, troca o arquivo no mesmo lugar e abre de novo. O `.deb` e o `.pacman` só avisam da versão nova e abrem a página dela, porque instalar pede a senha de administrador. Instalado por pacote, o app não tem o cartão **Atualização do PC**, que fica para a instalação pelo git.
- O PIN ainda é definido pelo `editr -pin`, da instalação pelo git.
- O que é do app fica em `~/.config/edit.r`: o tamanho da janela, os avisos e, em `logs/server.log`, o log do servidor que ele sobe.

Do repositório, sem empacotar: `pnpm desktop` compila e abre (`EDITR_PORT=7338 pnpm desktop` testa noutra porta, sem mexer no serviço).

### 1. Baixar e compilar

```sh
git clone -b release https://github.com/valb-mig/editr.git ~/Projects/editr
cd ~/Projects/editr
pnpm install
pnpm build        # gera web/dist, o app que o servidor entrega ao celular
```

O serviço do passo 3 espera o projeto em `~/Projects/editr`. Se clonar em outro lugar, ajuste o `WorkingDirectory` dele.

### 2. Testar à mão

```sh
pnpm --filter server start
curl http://127.0.0.1:7337/api/health      # em outro terminal: deve responder {"ok":true,...}
```

Abrir http://127.0.0.1:7337 no navegador do PC já mostra o painel. Pare com Ctrl+C.

### 3. Deixar rodando como serviço

O arquivo [`deploy/editr.service`](deploy/editr.service) sobe o servidor pelo shell interativo (`zsh -lic`) para herdar o PATH e as variáveis do seu `~/.zshrc`. Assim, o Claude aberto pelo celular enxerga as mesmas ferramentas do terminal (git, node, java…). Antes de instalar, confira o `ExecStart`:

- usa **bash** em vez de zsh? Troque `/usr/bin/zsh -lic` por `/bin/bash -lic`;
- o Node veio do nvm, fnm, mise ou asdf? Troque `/usr/bin/node` só por `node`, que o shell encontra no PATH.

```sh
systemctl --user link ~/Projects/editr/deploy/editr.service
systemctl --user enable --now editr
loginctl enable-linger "$USER"             # sobe no boot, mesmo sem login no PC
systemctl --user status editr
```

Se editar o arquivo depois de instalado, rode `systemctl --user daemon-reload` e reinicie o serviço.

### 4. Publicar na sua tailnet

No [painel de DNS do Tailscale](https://login.tailscale.com/admin/dns), deixe ligados **MagicDNS** e **HTTPS Certificates**. Depois, no PC:

```sh
tailscale serve --bg 7337      # se der "access denied": sudo tailscale set --operator="$USER"
tailscale serve status         # mostra o endereço, algo como https://seu-pc.tail1234.ts.net
```

A configuração do `--bg` sobrevive a reinícios. O servidor só escuta em `127.0.0.1`; o `tailscale serve` é a única porta de entrada, com HTTPS e só para a sua tailnet.

### 5. Instalar no celular

Pelo PC, o jeito mais fácil é o painel **Computador → Acesso**: ele mostra o link num QR para o celular escanear, confere o que falta no caminho (Tailscale no PC e no celular, MagicDNS, HTTPS, o link publicado) e marca cada passo sozinho conforme o celular chega. À mão:

1. Com o Tailscale ligado no celular, abra no Chrome o endereço do passo 4.
2. No menu ⋮, toque em **Instalar app** (ou **Adicionar à tela inicial**). No iPhone, pelo Safari: **Compartilhar → Adicionar à Tela de Início**.
3. Abra o app instalado e, no painel **Computador**, toque em **Ativar notificações** e permita. Toque em **Enviar teste** para conferir.

O painel passa a abrir como um app e avisa quando o Claude precisa de você.

### Quem pode acessar

O servidor confere o login do Tailscale de quem acessa (o `tailscale serve` informa no cabeçalho `Tailscale-User-Login`). Por padrão, só entra o dono do PC na tailnet. Para liberar outra conta, use `ALLOWED_LOGINS`: ela substitui o padrão, então inclua o seu login também.

### Quem está usando

Em **Computador → Acesso** ficam os aparelhos com o app aberto agora (com o nome do Tailscale, quantas janelas e desde quando), os acessos recentes e as tentativas barradas: uma conta do Tailscale que não é a sua e o PIN errado. Um aparelho que entra pela primeira vez, uma conta barrada ou o PIN errado demais avisam no celular, mesmo com o app fechado.

- **Desconectar** um aparelho fecha as janelas dele, invalida o token do PIN e o deixa de fora (sem API nem WebSocket) até você tocar em **Liberar**. O próprio PC e o aparelho em que você está não têm o botão.
- **Desligar o link** tira o painel da tailnet (`tailscale serve` desligado só nas portas que levam ao edit.r) e derruba quem estiver conectado por ela, inclusive o celular de onde você desligou. Para religar: no PC, pelo mesmo botão em `http://localhost:7337`, ou com `editr -link on`. O app religa nas mesmas portas que estavam publicadas.

O histórico fica em `~/.local/state/editr/access.json` (os 100 acontecimentos mais recentes).

### PIN

O Tailscale garante que só aparelhos seus chegam ao painel, mas não protege do celular desbloqueado na mão de outra pessoa. Para isso, defina um PIN de 4 a 8 dígitos no PC:

```sh
editr -pin       # pede o PIN duas vezes, sem mostrar
editr -pin off   # remove
```

Vale na hora, sem reiniciar o serviço. Daí em diante, o app abre numa tela de bloqueio, no celular e no navegador do PC (o acesso local também pede). Quem confere é o servidor: só o hash do PIN fica no PC (`~/.local/state/editr/pin.json`), e acertar dá um token que toda chamada da API e o WebSocket precisam levar, então abrir a API direto, sem o app, também esbarra no PIN. Depois de 5 erros seguidos, o servidor faz esperar 30 s, e a espera dobra a cada erro até 15 min. Trocar o PIN derruba todos os aparelhos destravados.

O app trava sozinho depois de 5 min sem uso ou no fundo. Em **Computador → Sobre → Segurança** dá para mudar o tempo (1, 5, 15 ou 30 min, ou **Ao sair**, que trava assim que o app vai para o fundo), desligar o travamento automático ou **Travar agora**. Esses ajustes valem para o aparelho. Fechar o app também trava; recarregar a página não.

Com várias máquinas, rode `editr -pin` em cada uma com o mesmo PIN: você digita uma vez e o app destrava todas. Uma máquina com PIN diferente fica sem conexão no app até você acertar o dela.

### Várias máquinas

Instale o edit.r em outra máquina sua da mesma tailnet (o mesmo login do Tailscale) e ela aparece sozinha no app, em até um minuto: cada servidor pergunta ao Tailscale quais máquinas do dono respondem como edit.r. Não há central: o app, instalado a partir de qualquer uma, fala direto com todas, e cada servidor aceita o app vindo de outra máquina sua (só do mesmo dono, nunca de outro endereço). Com uma máquina desligada, as outras seguem funcionando.

As notificações passam pela máquina de onde o app foi instalado: o celular só se inscreve nela, e as outras repassam os avisos para ela. Com ela desligada, os avisos das outras não chegam.

### Levar a configuração a outra máquina

Em **Computador → Sincronizar**, a configuração de uma máquina vai para um repositório privado seu no GitHub, e outra máquina (o PC do trabalho, o de casa) traz de lá. Vale também entre máquinas fora da mesma tailnet: o caminho é o GitHub, pelo login do `gh` de cada uma.

1. Na primeira máquina, escreva o nome do repositório (`editr-config`, ou `dono/nome`) e toque em **Criar privado**; um que já existe entra por **Usar existente** (também aceita um endereço git qualquer). Repositório público é recusado: a memória e os TODOs são seus.
2. Escolha o que vai junto e toque em **Enviar daqui**.
3. Na outra máquina, ligue o mesmo repositório e toque em **Trazer para cá**.

O que vai: times, workspaces (com os arquivos de contexto), habilidades do edit.r, comandos salvos, os agentes ligados; de cada projeto, TODOs (sem os anexos), detalhes e a memória do Claude; do Claude Code, o `settings.json`, o `CLAUDE.md`, os scripts soltos em `~/.claude` (como o da linha de status), os hooks, os seus agentes, skills e comandos; e a aparência do aparelho de onde você envia (tema, fundo, sons, fonte do código e outras preferências do app).

- **Fica o mais novo.** Cada item leva a data da última edição, e enviar ou trazer só troca o que é mais velho do outro lado. Antes de fazer, o app mostra a prévia: o que entra, o que muda e o que fica como está, e por quê (o do repositório é mais novo, você apagou aqui, o projeto não existe aqui).
- **Nada é apagado.** Apagar numa máquina não apaga no repositório nem nas outras; e o que você apagou aqui depois de ele passar por esta máquina não volta no próximo "Trazer".
- **Os projetos são achados pelo remoto do git**, então podem estar em pastas diferentes em cada máquina (`~/Projects/editr` aqui, `~/work/editr` lá). Sem remoto, pelo caminho ou pelo nome da pasta. Projeto que não existe na máquina fica de fora, com o nome dele na prévia: clone e traga de novo.
- **Os números dos TODOs são de cada máquina:** dois itens criados em máquinas diferentes com o mesmo número ficam com números diferentes quando se encontram.
- **Segredos ficam no PC:** nada de PIN, chaves das notificações ou credenciais do Claude Code; do `settings.json`, as variáveis de ambiente com cara de segredo (`*_TOKEN`, `*_KEY`, `*_SECRET`…) não vão, e as da máquina que traz continuam. Os servidores MCP (`~/.claude.json`) também não vão, porque costumam levar tokens. Caminhos da pasta pessoal viram `{{HOME}}` no repositório e voltam como a pasta pessoal da outra máquina.
- **O que um "Trazer" troca fica copiado antes** em `~/.local/share/editr/config-backup` (as últimas 10 vezes). O histórico do git no repositório guarda o resto.

O repositório é legível no GitHub: `times/`, `workspaces/`, `habilidades/` e `comandos/` com o que vale em todo projeto, `projetos/<nome>/` com o de cada projeto, `claude/` com o de `~/.claude`, e o `editr.json`, o índice que o edit.r segue. O clone fica em `~/.local/share/editr/config-repo`.

Cuidado com quem pode escrever no repositório: o `settings.json` e os hooks que vêm de lá rodam comandos na máquina que traz.

### Configuração

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `7337` | Porta local; o `tailscale serve` precisa apontar para ela |
| `PROJECT_ROOTS` | `~/Projects` | Pastas onde o celular pode abrir projetos, separadas por `:` (pasta nova de projeto vai na primeira; outras pastas podem ser adicionadas pela tela de Projetos) |
| `ALLOWED_LOGINS` | o dono do PC | Logins do Tailscale com acesso, separados por `,` |
| `EXTRA_ORIGINS` | (nenhuma) | Origens extras aceitas do navegador, separadas por `,` |
| `UPLOADS_DIR` | `~/.cache/editr/uploads` | Onde ficam os anexos enviados pelo celular |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Configuração e histórico do Claude Code, se você usa outra pasta |
| `MACHINE_NAME` | o nome do sistema | Nome desta máquina no app, quando há várias |
| `WHISPER_CLI` | `~/.local/share/editr/whisper/whisper.cpp/build/bin/whisper-cli` | Binário do Whisper para o ditado no Firefox (ver [Ditado no Firefox](#ditado-no-firefox-whisper)) |
| `WHISPER_MODEL` | `~/.local/share/editr/whisper/models/ggml-small-q5_1.bin` | Modelo do Whisper |
| `PIPER_BIN` | `~/.local/share/editr/piper/piper/piper` | Binário do Piper para a leitura em voz alta no PC (ver [Voz natural no PC](#voz-natural-no-pc-piper)) |
| `PIPER_VOICE` | `~/.local/share/editr/piper/voices/pt_BR-faber-medium.onnx` | Voz do Piper, com o `.onnx.json` ao lado |
| `ACTIVITY_FILE` | `~/.local/share/editr/activity.json` | Resumo do uso por dia, para o Início (sobrevive à limpeza dos registros pelo Claude Code) |
| `ACCESS_FILE` | `~/.local/state/editr/access.json` | Quem já usou o painel, os acessos recentes e os aparelhos desconectados (ver [Quem está usando](#quem-está-usando)) |
| `ORIGINS_FILE` | `~/.local/share/editr/origins.jsonl` | De que aparelho saiu cada mensagem mandada pelo app (ver [Usar pelo celular](#usar-pelo-celular)) |
| `MEMORY_TRASH_DIR` | `~/.local/share/editr/memory-trash` | Lixeira das memórias do Claude apagadas pelo app (ver **O que o Claude carrega**) |
| `MEMORY_SUGGESTIONS_FILE` | `~/.local/share/editr/memory-suggestions.json` | As memórias que o Claude quis guardar e esperam você (ver **Sugestões de memória**) |
| `CLAUDE_TRASH_DIR` | `~/.local/share/editr/claude-trash` | Lixeira das skills, comandos, agentes e configurações de servidores MCP tirados pelo app |
| `CONFIG_REPO_DIR` | `~/.local/share/editr/config-repo` | O clone do repositório de configuração (ver [Levar a configuração a outra máquina](#levar-a-configuração-a-outra-máquina)) |
| `CONFIG_SYNC_FILE` | `~/.local/share/editr/config-sync.json` | Que repositório é, quando você enviou e trouxe por último e o que esta máquina já viu dele |
| `WAKATIME_CLI` | `~/.wakatime/wakatime-cli` | Binário do WakaTime, para o seu tempo no painel contar lá (ver [WakaTime](#wakatime)); `WAKATIME=0` desliga |
| `WAKATIME_GOAL_HOURS` | `4` | Quantas horas de hoje enchem a medida do WakaTime no PC |
| `EXTRA_MACHINES` | (nenhuma) | Outras máquinas além das achadas no Tailscale (ex.: uma instância de teste, `http://127.0.0.1:7338`), separadas por `,` |
| `ARTEFATOS_FILE` | `~/.local/share/editr/artefatos.json` | Os artefatos e a lixeira deles (ver **Artefatos**); as versões ficam em `ARTEFATOS_DIR` (`~/.local/share/editr/artefatos/`) |
| `ARTEFATOS_PUBLIC_PORT` | `PORT + 2` | Porta local do servidor do link público dos artefatos, só em `127.0.0.1` |
| `ARTEFATOS_FUNNEL_PORT` | `8443` | Porta do Tailscale Funnel do link público (`8443` ou `10000`; a `443` é a do próprio edit.r e é recusada) |
| `EDITR_URL` | `https://<máquina>.ts.net` | Endereço do app, para o link que o Claude recebe ao publicar um artefato (numa instância de teste, o da porta dela) |

No serviço, defina com `systemctl --user edit editr` e depois `systemctl --user restart editr`:

```ini
[Service]
Environment=PROJECT_ROOTS=%h/Projects:%h/code
```

### Ditado no Firefox (Whisper)

O ditado do Chrome e do celular usa o reconhecimento de voz do navegador, e o Firefox não tem. Para ditar pelo Firefox, instale o Whisper no PC, que transcreve ali mesmo, sem internet e sem o áudio sair do PC:

```sh
deploy/install-whisper.sh        # compila o whisper.cpp e baixa o modelo small-q5_1 (~190 MB)
```

Precisa de git, cmake e um compilador de C++. O servidor acha o Whisper sozinho, sem reiniciar, e o microfone passa a aparecer no Firefox. O modelo `small-q5_1` vai bem em português e usa uns 400 MB de memória só enquanto transcreve. Com mais memória sobrando, o `large-v3-turbo-q5_0` acerta mais (`deploy/install-whisper.sh large-v3-turbo-q5_0` e `WHISPER_MODEL` apontando para ele).

### Voz natural no PC (Piper)

O **Ouvir** usa a voz do aparelho. No celular ela é boa, mas no PC com Linux o navegador fala pelo speech-dispatcher, que vem com o espeak: robótico e difícil de entender. Para ouvir no PC com uma voz natural, instale o Piper, que gera a fala ali mesmo, sem internet:

```sh
deploy/install-piper.sh          # baixa o Piper e a voz pt_BR-faber-medium (~90 MB)
```

O servidor acha o Piper sozinho, sem reiniciar; recarregue a página no PC. Cada frase é gerada no PC enquanto a anterior toca, então só a primeira demora um instante. O celular segue com a voz dele. Se o Piper falhar no meio de uma leitura, ela continua com a voz do navegador. Há outras vozes em português (`cadu-medium`, `jeff-medium`, `edresson-low`): `deploy/install-piper.sh cadu-medium` e `PIPER_VOICE` apontando para ela.

### WakaTime

Se você usa [WakaTime](https://wakatime.com), o tempo com o Claude pelo painel conta lá, no projeto certo.

São dois lados. O que o **Claude faz** já vem do próprio `wakatime-cli`, que lê os transcritos das conversas (`wakatime-cli --sync-ai-activity`) e manda como *AI Coding*; quem dispara isso costuma ser o plugin do editor, então, com o editor fechado, vale deixar um timer do systemd rodando a cada poucos minutos:

```ini
# ~/.config/systemd/user/wakatime-ai-sync.service
[Service]
Type=oneshot
ExecStart=%h/.wakatime/wakatime-cli --sync-ai-activity
Nice=10
```

```ini
# ~/.config/systemd/user/wakatime-ai-sync.timer
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

Depois: `systemctl --user enable --now wakatime-ai-sync.timer`.

O outro lado é o **seu**: ler a resposta, conferir um diff, escrever a próxima mensagem. Nada disso vira transcrito, e por isso o servidor manda os heartbeats dele mesmo, com as regras dos plugins de editor (um por arquivo a cada dois minutos, no máximo): abrir um arquivo no explorador ou ver um diff conta como *code reviewing*, e o tempo mexendo numa conversa conta no projeto dela. Parou de mexer ou saiu do app, para de contar.

Com isso em pé, o PC ganha a medida **Hoje**, acima da de CPU (no pé da lista de conversas ou, com ela recolhida, na alça): quanto você já codou hoje (o que o Claude fez mais o seu tempo), pelo mesmo número que o `wakatime-cli --today` mostra. Ele enche até a meta de `WAKATIME_GOAL_HOURS` e fica verde ao bater.

Sem o `wakatime-cli` instalado, nada disso acontece: a medida não aparece e o painel segue igual. Para desligar com ele instalado, use `WAKATIME=0`.

### Problemas comuns

- **A página não abre no celular:** confira se o Tailscale está ligado nos dois aparelhos e se `tailscale serve status` aponta para a porta 7337.
- **Erro `tailnet_identity_required`:** o celular está em outra conta do Tailscale; ponha os dois logins em `ALLOWED_LOGINS`.
- **Erro `host_not_allowed`:** acesse pelo nome `https://….ts.net`, não pelo IP.
- **Pelo celular, o Claude não acha ferramentas que existem no terminal:** o serviço não carregou o seu shell. Revise o `ExecStart` (passo 3).
- **Logo depois de ligar o PC, só o acesso local funciona:** o serviço pode subir antes do Tailscale; ele tenta de novo a cada 15 s.
- **As notificações não chegam:** use **Enviar teste** no painel Computador. Se aparecer erro, ele vem do serviço de push; se não der erro e nada chegar, libere as notificações do app e tire o Chrome da otimização de bateria nas configurações do Android. Falhas de envio aparecem nos logs como `falha ao enviar notificação`.
- **Qualquer outra coisa:** `journalctl --user -u editr -f` mostra os logs.

### Atualizar

O PC instalado segue a branch `release`, a das versões publicadas (ver [Publicar uma versão do app](#publicar-uma-versão-do-app)); a `main` recebe os commits do dia a dia.

```sh
cd ~/Projects/editr
git pull
pnpm install
pnpm build
systemctl --user restart editr
```

Vindo de antes da troca de nome (quando o projeto se chamava cald, ou claude-remote): rode `./deploy/install.sh` de novo, de um terminal fora do painel (ele troca o serviço, e as conversas do painel caem). Ele desliga o serviço antigo (`cald` ou `claude-remote`), sobe o `editr` e troca o comando antigo (`cald` ou `cr`) por `editr`. As pastas de dados (`~/.local/share/cald` e as outras) mudam de nome sozinhas na primeira subida e ficam como atalho para as novas. As habilidades passam a ser chamadas com `/editr:nome`.

Ou pelo celular, no painel **Computador**, cartão **Atualização do PC**: ele mostra as novidades da `release` do GitHub, e **Atualizar e reiniciar** faz os passos acima (trocando para a `release`, se o PC estiver noutra branch; uma instalação de antes, ainda na `main`, passa para ela na primeira atualização). Um PC noutra branch que já tem tudo da `release`, como a `main` de quem desenvolve, fica em dia e não troca de branch. A atualização recusa se o repositório no PC tiver mudanças não commitadas, se a `release` do PC tiver commits que não estão no GitHub ou se alguma conversa do painel estiver trabalhando ou esperando resposta. O painel fica fora do ar por alguns segundos, e as conversas que estavam abertas nele são reabertas sozinhas, com o mesmo modelo e modo.

Com o app aberto no celular, aparece o aviso **Versão nova do app**: toque em **Atualizar**. Ao voltar para o app, ele procura sozinho a versão nova.

## Usar pelo celular

O que dá para fazer:
- **Início:** o app abre aqui (no PC, ao lado da lista de conversas, quando nenhuma está aberta). Uma saudação com a data e, numa linha, o que está acontecendo (quantas conversas pedem você, quantas trabalham, quanto do limite de 5 h foi usado). Abaixo:
  - **Pedindo você / Agora**: aprovações e perguntas de todas as conversas do painel, com os mesmos cartões do chat para responder ali mesmo; as abertas no PC que esperam você levam até elas; e as que estão trabalhando ou com algo em segundo plano.
  - **Limites do plano** (5 h, semana e por modelo) com previsão pelo ritmo desde o começo da janela: até onde vai ou, se for acabar antes de renovar, quando (em laranja). Embaixo, CPU, memória e processos do Claude no PC.
  - **Dias com o edit.r**: o ano em quadradinhos, como o grid de contribuições do GitHub, com a cor mais forte nos dias com mais sessões pelo edit.r (**Tudo** conta também as do terminal e do VSCode). Mostra os dias de uso, a sequência atual e o recorde; tocar num dia mostra as sessões, as mensagens e o custo.
  - **Últimos 30 dias**: custo estimado, mensagens suas, dias de uso e tokens; o custo de cada dia em colunas; um mapa de calor dos dias da semana e horários em que você mais usa; e os projetos que mais consumiram. O custo é a preço de tabela da API.
  - **Projetos recentes**: branch e arquivos não commitados de cada um, a última conversa, quanto custou em 30 dias e **+** para começar uma conversa nova nele.
  - O histórico vem dos registros das conversas no PC, que o Claude Code apaga depois de ~30 dias; por isso o servidor guarda um resumo por dia em `~/.local/share/editr/activity.json`, e o grid não perde os dias antigos. Dias de antes dos registros que ainda existem vêm do histórico de mensagens do terminal (`~/.claude/history.jsonl`), sem custo.
- **Salinha** (`/salinha`; o atalho fica no painel Computador): um prédio de escritórios desenhado em SVG para deixar de fundo e acompanhar tudo de uma vez. Cada conversa aberta (no painel ou no PC) é uma área do escritório, separada das outras por divisórias; cada andar tem áreas dos dois lados do corredor (no celular, uma por andar, com o corredor à esquerda), e conversa nova ganha área nova, no lugar onde fica até fechar.
  - **Estações:** o claudinho da conversa (o mesmo do avatar dela, com o nome dele) e os funcionários (os subagentes, cada um com um claudinho sorteado) chegam pelo elevador e vão até a estação do que estão fazendo: mesa com o PC (web, inclusive `curl`), gaveteiro (lendo e procurando arquivos, inclusive `cat`, `grep` e afins no terminal, e compactando a conversa), bancada (editando), terminal (comandos), quadro (planejando e coordenando), café (pensando) e sofá (descansando, com a TV ligada quando algo roda em segundo plano); quem pede você sai até o corredor com um "!". A última ferramenta segura o claudinho na estação por alguns segundos, porque Read e Edit acabam antes da salinha perguntar, e cada um fica um tempo mínimo onde chegou antes de ir para outra.
  - **O que acontece na conversa vira animação:** cada arquivo editado é uma folha voando para a pilha da bancada; erro solta fumaça e um "!?"; teste acende o semáforo do rack, verde ou vermelho; `git commit` faz o claudinho levar uma caixa ao elevador, e `git push` ou `gh pr create` chama o caminhão de entregas na rua; skill tira um livro da estante; o quadro mostra as tarefas da conversa (TodoWrite) com a barra de progresso; o subagente que termina entrega uma pasta ao claudinho da conversa antes de ir embora; turno encerrado ou pedido respondido ganham um ✓. O claudinho da conversa usa o chapéu do modelo: coroa no Opus, chapéu de mago no Fable, boina no Sonnet e brotinho no Haiku.
  - **Vida própria:** os claudinhos piscam, olham para a tela, digitam em rajadas e andam de lá para cá pensando. Parado, cada um descansa de um jeito e troca de tempos em tempos: cochila na cadeira com a cabeça caída, senta no sofá (que cabe dois), olha a cidade pela janela, rega a planta, pega um livro na estante, vai ao café, ao bebedouro do corredor ou ao quadro, se espreguiça — e, com dois na mesma área, os dois se encontram no meio da sala para conversar. Ninguém ocupa o mesmo canto que o outro. A área que pede você pulsa em âmbar (e a salinha rola até ela), a que descansa à noite apaga a luz, e com o limite de 5 h estourado o escritório fecha, com "VOLTA ÀS…" no letreiro.
  - **Cidade:** o céu segue o relógio aos poucos, com o sol e a lua cruzando, nuvens, avião, pássaros e, de vez em quando, chuva. Na rua, carros, vans e ônibus passam nas duas mãos, de faróis acesos à noite e guardando distância de quem vai à frente, e gente anda na calçada, de guarda-chuva quando chove. Tudo na escala dos claudinhos: quem passa na calçada tem a altura de um deles, e um carro, umas duas vezes e meia isso de comprimento. No Halloween aparecem abóboras e morcegos, na festa junina, bandeirinhas, e no Natal, luzinhas no telhado.
  - **Toques:** tocar num claudinho mostra o que ele faz (e ele pula); tocar na área abre a conversa ou, se ela pede você no painel, os pedidos ali mesmo, para aprovar sem sair. Para as conversas abertas no PC, o servidor lê o fim do registro delas (só de novo quando ele muda). No topo, dá para manter a tela acesa e abrir em tela cheia; `/salinha?demo` mostra um escritório de mentira, cheio, e `?hora=21` e `?chuva` mudam o céu para ver como fica.
- **Conversas:** no topo, um quadro com CPU, memória e os limites do plano do Claude (janela de 5 h e semana, com horário de reset). Abaixo, as conversas, nesta ordem: as que precisam de você, as fixadas, as abertas agora e as recentes. A aba mostra um contador das que precisam de você. Segurar o dedo numa conversa (ou clicar com o botão direito, no PC) abre o menu dela com **Apagar conversa**, que pede confirmação; a aberta no PC não pode ser apagada até ser fechada lá.
- **Nova** (nas Conversas) pergunta só onde trabalhar, sem projeto (`~`) ou um projeto, e abre um chat vazio. A primeira mensagem, digitada na própria caixa do chat com modelo, modo, `/`, `@` e anexos, cria a sessão.
- **Conversas em paralelo no mesmo projeto:** várias conversas podem mexer no mesmo checkout ao mesmo tempo, e o app mostra quem está junto com quem.
  - Nas listas de conversas, o estado fica só no claudinho: os pontinhos enquanto trabalha, o balão de exclamação quando espera você.
  - Na lista de conversas do PC, as abertas de um projeto (no painel ou no PC) ficam ligadas por um **trilho**, como num grafo do git, embaixo da setinha do grupo. Cada uma aberta no checkout é um nó: azul e pulsando trabalhando, âmbar esperando você, vazado aberta e parada. Entre duas ou mais trabalhando ao mesmo tempo, o trecho do trilho fica azul, com uma corrente descendo por ele: os mesmos arquivos mudando por mais de uma conversa. A conversa num worktree sai do trilho numa curva, porque roda numa cópia só dela.
  - Cada projeto, na lista do PC, nas abas do celular, na tela **Projetos** e no hub dele, leva a **marca** dele: a logo ou o favicon que o próprio repositório já tem (o PC procura em `public/`, `app/`, `src/assets/`, `.github/` e na raiz, também dentro de `web/`, `frontend/`, `client/` e `apps/web/`, e ignora o favicon padrão do create-next-app). Sem uma, a inicial num quadradinho com a cor do projeto. Se a achada não servir ou não houver nenhuma, o botão direito no projeto (no celular, segurar o dedo) abre **Escolher uma logo…**: a imagem vem do aparelho, o PC a reduz e a guarda fora do repositório (`~/.local/share/editr/project-icons`), e ela passa na frente da do repositório em todos os aparelhos; **Tirar a logo** desfaz. Ao lado, os claudinhos das conversas dele, quem trabalha primeiro (piscando), também com o grupo recolhido; as que não cabem viram um "+n".
  - **A mesa do projeto** (o hub dele, numa aba do PC, aberto pelo nome do projeto): as conversas abertas nele (no painel ou no PC, inclusive as dos worktrees dele) lado a lado, em miniatura, quantas couberem por linha. Cada miniatura é a conversa de verdade: as mensagens ao vivo, as aprovações e perguntas para responder ali mesmo e a caixa de mensagem. Tocar no topo dela a abre como aba, com o resto (mapa, agentes, menu). Cada uma fica no lugar enquanto está aberta, sem pular quando muda de estado. A primeira vaga é a caixa de uma conversa nova, que já vem num worktree próprio, com quem trabalha no projeto numa linha só (os claudinhos e a conta); mandar não sai da mesa, e a conversa nova aparece logo ao lado. Sem conversa aberta, a caixa ocupa o alto da página, com a pergunta do dia e os atalhos para a issue ou o TODO. A aba **Worktrees**, no topo, mostra os worktrees do projeto, como na seção do Computador, e a **Detalhes**, os detalhes dele (ver **Detalhes do projeto**). Embaixo, as conversas fechadas, os PRs, as issues, o TODO e o uso dos últimos 30 dias. Com o fundo da conversa ligado, a mesa fica sob o mesmo véu, com os blocos de vidro.
  - No cabeçalho do chat, um selo **com Juju** (os claudinhos e os nomes; numa conversa estreita, só os claudinhos) diz quem mais trabalha agora no mesmo checkout. Ele abre a lista: o que cada uma faz neste momento (a ferramenta, como na salinha) e as abertas paradas ou esperando você. Escolher uma a abre ao lado.
- **Worktrees:** com outra conversa já aberta no projeto (no painel ou no PC), a conversa nova (na tela **Nova** ou no hub do projeto) avisa quem trabalha lá agora, com os claudinhos ("Pepe e Juju trabalham em edit.r agora · 2 abertas paradas"), e já vem com **Rodar em worktree** ligado, para não mexer nos mesmos arquivos. Na mesa do projeto, ela vem ligada sempre, mesmo sem ninguém lá. As paradas também contam, porque voltam a mexer na próxima mensagem. Ligado, ela abre num [git worktree](https://git-scm.com/docs/git-worktree) só dela, em `<projeto>/.claude/worktrees/<nome>` (o mesmo lugar do `claude --worktree`), numa branch `editr/<nome>` que sai do commit atual do projeto. O nome vem do começo do pedido. Sem conflito, a chave fica à mão, desligada.
  - Antes da primeira mensagem, o servidor instala as dependências pelo lockfile (pnpm, bun, yarn ou npm, primeiro pelo cache local). Se falhar, a conversa abre mesmo assim, e o Claude fica sabendo. As configurações do projeto (as permissões do `settings.local.json`, skills e hooks) vêm do checkout principal, e o Claude é avisado de que está num worktree, para não mexer no checkout das outras conversas. A pasta entra no `.git/info/exclude`, então não aparece no `git status` do projeto.
  - Na lista, a conversa fica no grupo do projeto, com o nome do worktree. No chat, o botão da branch no cabeçalho tem um selo com quantos commits ela tem para levar à branch de origem (verde quando já dá para trazer), e o menu dele mostra a branch, os arquivos sem commit e quanto a de origem andou. **Trazer**, no menu, faz o merge dessa branch na de origem, no checkout principal (avança quando dá; senão, um commit de merge). Ele só vai com tudo commitado e com o projeto na branch de origem. Em conflito, o merge é desfeito e a mensagem diz em quais arquivos: peça ao Claude, no worktree, para trazer a branch de origem e resolver. O worktree continua depois do Trazer, para a conversa seguir.
  - **Remover o worktree**, no mesmo menu, apaga o worktree. A branch sai junto quando tudo dela já está na branch de origem, mesmo que com outro hash (um commit rebaseado conta como trazido); com commits que não voltaram, ela fica, para trazer depois. Se algo ainda não voltou, a confirmação diz o que se perde. As conversas do painel que estavam nele são fechadas e ficam na lista, só para leitura. Os worktrees criados no terminal com `claude --worktree` também ganham o botão.
  - Os worktrees de todos os projetos, inclusive os criados à mão em qualquer pasta, ficam no painel **Computador**, em **Worktrees** (ver **O que o Claude carrega**).
- **Inbox:** tudo o que pede você num lugar só, com o número de novos no botão (na alça do PC, abre numa aba, como o hub do projeto; no celular, é a segunda aba da pílula). Por urgência: conversas esperando você (aprovações e perguntas); PRs pedindo sua revisão; PRs seus com check falhando, mudança pedida, conflito ou aprovados e prontos para o merge; issues atribuídas a você ou que te mencionam; projetos com mudança sem commit, commits sem push ou atrás do remoto; e os TODOs a fazer. PRs e issues vêm do GitHub da conta inteira (uma busca só pelo `gh`, com o cache de 2 min do resto do GitHub), mesmo de repositórios que não estão clonados no PC; os que estão abrem numa aba do PC, os outros no GitHub.
  - No alto, a busca (título, projeto, repositório, label), os chips de cada tipo com quantos novos ele tem e o filtro por período, por projeto e por label. O período (hoje, últimos 7 dias, últimos 30 dias ou **parados há mais de 30 dias**, para achar o que ficou esquecido) olha a data do item: a última atividade do PR ou da issue, a criação do TODO, a última mensagem da conversa; as mudanças nos projetos não têm data e só aparecem em "Qualquer data". As labels do GitHub aparecem em cada PR e issue, com a cor delas.
  - Cada item tem ✓ (visto) e, no ⋯, **Pedir ao Claude** (uma conversa nova no projeto com o pedido já escrito, como "os checks do PR #12 estão falhando, veja o que quebrou e corrija"), **Adiar até amanhã** (8h) e **Abrir no GitHub**. Visto e adiado ficam no PC principal (`inbox.json`, ou `INBOX_FILE`) e valem em todos os aparelhos; o item visto volta como novo quando muda (commit novo no PR, mais arquivos alterados). Embaixo, **Adiados** e **Vistos** recolhidos, para desfazer.
- **Paleta de comandos** (Ctrl+K, ⌘K no Mac; no terminal o Ctrl+K continua do shell): achar e abrir qualquer coisa pelo nome. Sem nada digitado, mostra as conversas esperando você (aprovações e perguntas), as últimas conversas, os projetos mais usados e a inbox, com o número de novos e os itens novos mais recentes. Buscando, procura em todas as conversas (título, nome do claudinho, projeto, branch, workspace), nos projetos de todas as máquinas e nos itens da inbox, sem ligar para acento. Cada coisa abre como abriria pela lista: a conversa na aba dela, o projeto no hub, o PR ou a issue numa aba. O que foi digitado também vira uma pergunta: **Perguntar** (ou Ctrl+Enter de qualquer linha) cria uma conversa nova com o texto como primeira mensagem, no projeto da conversa em foco (ou no último usado), num worktree próprio quando outra conversa já está aberta nele, como na conversa nova; **Em outro projeto…** abre a escolha do projeto. O Ctrl+P segue sendo o dos arquivos do projeto.
- **Projetos:** escolher um diretório do PC para iniciar uma sessão nova. Os projetos com mudanças no git sobem para o grupo **Com mudanças**, com selos de arquivos não commitados, commits para enviar (↑) e commits novos no GitHub (↓). A tela mostra primeiro o estado local e depois consulta o remoto com `git fetch` (no máximo a cada 10 min por projeto, sem nunca pedir senha: sem chave ou credencial que funcione sozinha, o ↓ fica no último fetch). O botão de pasta com **+** no topo adiciona projetos: uma **pasta nova**, criada na primeira pasta de `PROJECT_ROOTS` (com `git init`, se quiser), ou uma **pasta existente** em qualquer lugar do PC, escolhida navegando pelas pastas ou digitando o caminho. As pastas de fora de `PROJECT_ROOTS` ficam guardadas no PC (em `meta.json`) e passam a aceitar conversas; no mesmo diálogo dá para tirá-las da lista, sem apagar nada. A pasta pessoal e as de cima dela não podem ser projeto.
- **Computador:** detalhes do sistema (carga, swap, processos do Claude e memória deles, tempo ligado), os agentes (ver **Agentes**), a conexão, as notificações, os sons e o tema. Não é uma tela: abre como painel por cima de onde você está, então dá para conferir o PC ou mudar um ajuste sem sair da conversa. Abre pela aba no celular e, no PC, pela alça, pelas medidas e pelo quadro do PC no início; fecha pelo X, tocando fora ou com o voltar do celular.
- **Habilidades do edit.r** (o botão de varinha no pé da alça da direita; no celular, no topo da folha da barra do projeto): skills do próprio edit.r, e não do Claude Code. Cada uma tem um nome, que vira o `/editr:nome`, a descrição de quando usar e as instruções, e vale **em todo projeto** (global) ou **só num projeto**; com o mesmo nome, a do projeto ganha da global ali.
  - Nas conversas do painel, o Claude as vê como skills: carrega uma quando a descrição bate com o pedido, ou quando você a chama com `/editr:nome`, que aparece no autocompletar do `/` junto dos comandos. O edit.r monta para cada conversa um plugin "editr" com as que valem nela (`~/.cache/editr/habilidades`) e o passa ao abrir; criar, editar ou desligar uma faz a conversa reler na hora, sem reiniciar. As conversas abertas no terminal ou no VSCode não as veem.
  - O modal mostra as **deste projeto** e as **globais**. Com uma conversa em foco, cada uma tem o botão de ligar e desligar **nesta conversa** (toda habilidade começa ligada, e o desligado segue a conversa numa bifurcação). Numa conversa aberta no PC, o que você mudar vale quando ela vier para o painel.
  - **Nova** e o lápis abrem o editor (nome, onde vale, quando usar e instruções em Markdown). A lixeira tem **Desfazer** ali mesmo e, no pé do modal, **Restaurar** e **Apagar de vez**; o que passa de 30 dias lá some sozinho. Elas ficam guardadas no PC, em `~/.local/share/editr/habilidades.json`.
- **Detalhes do projeto:** notas suas sobre como cada parte de um projeto funciona ("Avatares": de onde vem o ícone, que arquivo sorteia o claudinho…), cada uma com um título e o conteúdo em Markdown, com `@` para arquivos e o olho para ver como fica. Servem para o Claude não ler o projeto inteiro só para entender uma parte: toda conversa do painel no projeto abre sabendo só a chave e o título de cada detalhe (poucos tokens, junto das instruções do MCP do edit.r) e lê o conteúdo do que o trabalho tocar, pelas ferramentas `listar_detalhes` e `ler_detalhe`, sem pedir aprovação. Você escreve no app ou pede ao Claude ("adiciona nos detalhes o visual do projeto"): ele estuda a parte e grava com `criar_detalhe` ou `editar_detalhe`, que pedem sua aprovação.
  - No PC, ficam no hub do projeto, na aba **Detalhes**: a lista e o editor lado a lado. No celular, e também no PC, o menu do projeto (botão direito ou dedo segurado no projeto em **Projetos**, nas **Conversas** ou na barra do projeto) tem **Detalhes**, que no celular abre uma folha com a lista; tocar num detalhe o abre no lugar dela.
  - Salva sozinho logo depois de parar de digitar. A chave sai do título (`Avatares e ícones` vira `avatares-e-icones`) e aparece no alto do editor. Um detalhe sem conteúdo fica apagado na lista e não entra no índice. Apagar tem **Desfazer**.
  - O índice vale como estava ao abrir a conversa: um detalhe novo entra na próxima (ou na hora, se o Claude chamar `listar_detalhes`). Numa conversa em worktree, os detalhes são os do projeto de que ele é cópia. Ficam no PC, em `~/.local/share/editr/detalhes.json`.
- **MCP do edit.r:** nas conversas do painel, o Claude tem ferramentas para mexer no próprio edit.r: o TODO do projeto, os times, os workspaces e as habilidades. Dá para pedir "estuda este projeto e monta um time pra me ajudar a codar nele" ou "quebra isso em TODOs", e ele vai marcando cada TODO como feito ao terminar. Para montar um time, ele é instruído a estudar o projeto antes (CLAUDE.md, README, stack, comandos, convenções) e a escrever para cada membro instruções daquele projeto.
  - **TODO:** `listar_todos`, `criar_todos` (vários de uma vez) e `editar_todo` (título, descrição, feito). Um `TODO:n` mencionado na mensagem já lembra o Claude de marcá-lo no fim. Numa conversa em worktree, o TODO é o do projeto de que ele é cópia, também na barra da direita e no `TODO:n`.
  - **Detalhes do projeto:** `listar_detalhes` (chave e título) e `ler_detalhe` (vários de uma vez, pela chave), sem aprovação; `criar_detalhe` e `editar_detalhe` (título ou conteúdo, pela chave) pedem aprovação, porque o índice abre toda conversa do projeto. Criar com o título de um que já existe é recusado, para o Claude editar aquele. O índice dos detalhes já vai nas instruções do MCP de cada conversa (ver **Detalhes do projeto**).
  - **Times:** `listar_times`, `criar_time`, `editar_time` e `usar_time`, que põe o time na própria conversa. Como o SDK fixa os subagentes quando o processo sobe, a conversa reabre com o time assim que a resposta termina (e nada mais roda em segundo plano), pelo mesmo caminho do seletor de time.
  - **Workspaces:** `listar_workspaces`, `criar_workspace` (sem projetos, fica o da conversa; vira o padrão do projeto principal, se ele não tem um) e `editar_workspace`. **Habilidades:** `listar_habilidades`, `criar_habilidade` (global ou do projeto) e `editar_habilidade`, que já valem na própria conversa.
  - Ler, criar e marcar TODOs e criar time ou workspace passam sem pedir. Editar time ou workspace e criar ou editar habilidade pedem aprovação: uma habilidade global vale em todo projeto, e um arquivo de um repositório qualquer poderia convencer o Claude a plantar uma instrução ali. Nada se apaga por ele; tirar algo é com você, pelo app.
  - O que muda, pelo Claude, pelo app ou em outro aparelho, aparece na hora em todos os aparelhos. O app manda o TODO inteiro a cada mudança, então o PC recusa uma lista velha (`409 todos_changed`) em vez de apagar o item que o Claude acabou de criar; o app avisa e mostra como ficou.
  - É um servidor MCP dentro do próprio edit.r (`server/src/editr-mcp.ts`), montado por conversa: as abertas no terminal ou no VSCode não o veem, e ele não aparece na seção **MCP** do Computador.
- **Agentes** (painel **Computador → Agentes**, da máquina escolhida no topo): quem conduz as conversas. Hoje é só o Claude Code; a seção está pronta para outros (ver [Agentes](#agentes) em Desenvolvimento). Cada agente é uma linha com a versão, se é o padrão das conversas novas (ou o que falta no PC, em âmbar) e a chave de ligado; sempre fica um ligado, e o que não está instalado não liga. Tocar na linha abre a página dele, com abas só para o que ele oferece:
  - **Geral:** ligado, **Padrão nas conversas novas** (para trocar, faz-se outro o padrão) e como ele está no PC (pronto ou não, e a versão).
  - **Uso** (no Claude Code): os limites do plano, todas as janelas, inclusive por modelo. As medidas de 5 h e semana da alça e o **Detalhes** do cartão de limites do início abrem direto aqui.
  - **Memória**, **Skills** e **MCP** (no Claude Code): ver **O que o Claude carrega**, logo abaixo.
  - Com mais de um agente ligado, a conversa nova ganha uma pílula antes do modelo para escolher qual conduz a conversa, começando no padrão; trocar de agente troca os modelos, e o esforço e os modos de permissão aparecem conforme o que ele aceita. A conversa já começada segue com o agente dela.
  - Os links antigos do painel (`?computador=uso`, `memoria`, `skills`, `mcp`) abrem a aba correspondente do Claude Code.
- **O que o Claude carrega:** a memória que ele guardou, as skills, os comandos, os agentes e os servidores MCP. Fica no painel **Computador → Agentes → Claude Code**, nas abas **Memória**, **Skills** e **MCP** (da máquina escolhida no topo), no que vale em todo projeto; os worktrees ficam na seção **Worktrees** do Computador. Serve para entender por que o Claude fala de algo que você não lembra de ter pedido, e para dar uma limpa.
  - **Memória:** a memória automática do Claude Code, que fica em `~/.claude/projects/<projeto>/memory`, um arquivo por lembrança e o índice `MEMORY.md`, lido no começo de cada conversa naquele projeto. Um grupo por projeto; a aba **Memória** (e o item **Agentes** do painel) ganha um número quando alguma ficou fora do índice ou o índice cita arquivo que não existe. A busca olha também o texto. Os filtros mostram o que pede limpeza: **Fora do índice** (o Claude não chega a vê-la), **Órfã** (o projeto não existe mais), **Velha** (sem mudar há mais de 60 dias) e **Link sem memória** (um `[[nome]]` que ainda não existe, às vezes de propósito), além do tipo (jeito de trabalhar, projeto, referência, sobre você). O grupo avisa também quando o índice passa de 150 linhas (o Claude Code só lê as primeiras 200) ou cita arquivo que não existe.
    - Tocar numa memória mostra o texto, quem a cita e **De onde veio**, que abre a conversa em que o Claude a guardou (se ela ainda existe: o Claude Code apaga as conversas depois de uns 30 dias). **Editar** muda a descrição e o texto, e o resto do cabeçalho fica como estava; se o Claude mexer nela enquanto o editor está aberto, salvar recusa, para não apagar o que ele escreveu.
    - **Para a lixeira**, de uma ou de várias (a caixinha de cada uma, ou a do projeto para todas), tira a memória e a linha dela do índice, com **Desfazer** no pé da lista por alguns segundos. Elas vão para a lixeira do edit.r (`~/.local/share/editr/memory-trash`, ou `MEMORY_TRASH_DIR`), no pé da lista: **Restaurar** devolve o arquivo e a linha no mesmo lugar do índice, **Esvaziar** apaga de vez, e o que passa de 30 dias lá some sozinho.
    - **Sugestões de memória:** nas conversas do painel, o Claude não grava memória sozinho. Quando ele tenta (um Write ou Edit na pasta de memória), o edit.r guarda o texto como sugestão e devolve a ele um aviso de que ela não foi gravada, e o Claude segue trabalhando, sem travar a conversa. No chat, a ferramenta aparece como **Sugeriu uma memória**, e não como erro. No topo da conversa surge o botão da lâmpada, com quantas esperam você, que abre a lista da conversa. Cada sugestão mostra o nome, a descrição, o tipo, se é **nova** ou se **atualiza** uma que existe, e o texto, que abre inteiro ao tocar. Os botões são estes:
      - **Salvar** grava a memória e põe a linha dela no fim do `MEMORY.md`, se ainda não houver uma. Se a memória mudou ou apareceu desde a sugestão, salvar recusa, para não passar por cima.
      - **Editar** abre a descrição e o texto para mudar antes de salvar.
      - **Mencionar** põe "Sobre a memória que você sugeriu, “nome”:" na caixa de mensagem, para falar dela com o Claude. Se ele gravar o mesmo arquivo de novo, a sugestão é trocada pela nova.
      - **Recusar** tira da lista, com **Desfazer** no pé dela.
      - O Claude costuma pôr a linha do índice junto com a memória. Uma mudança no `MEMORY.md` que passaria a citar uma memória que não existe também fica de fora, e a linha entra quando você salva.
      - As sugestões ficam no PC (`~/.local/share/editr/memory-suggestions.json`) e somem depois de 30 dias sem resposta. As conversas abertas no terminal ou no VSCode gravam memória como sempre.
    - **Revisar com o Claude** (aberto o grupo de um projeto) abre uma conversa nova nele com o pedido já escrito, sem enviar: juntar as repetidas, encurtar as longas, propor apagar o que o código ou o git já dizem e manter o índice em dia, mostrando a lista antes de mexer. O que ele apagar por ali não passa pela lixeira do edit.r.
  - **Skills:** as skills, os comandos e os agentes que o Claude Code carrega, agrupados pela origem: **Suas** (`~/.claude/skills`, `commands` e `agents`), **Da sua conta no claude.ai** (as sincronizadas), **De plugins** e **Do próprio Claude Code**. Tocar mostra o arquivo e o texto inteiro. Quando uma skill cita um servidor MCP que não está ligado ali (como uma que fala do board do Cordel num projeto sem o MCP `cordel`), ela ganha o selo **cita MCP … · desligado aqui**, e um aviso no topo junta todas: é daí que o Claude fala de coisas que não tem.
    - **Ligar e desligar** uma skill ou comando usa o `skillOverrides` do próprio Claude Code (o mesmo do `/skills`): desligada, o Claude não a vê nem atende o `/nome`. Vale em todo projeto (nas suas configurações, `~/.claude/settings.json`); para um projeto só, use o `/skills` numa conversa dele. As desligadas continuam na lista, apagadas, com o filtro **Desligadas**. Skill de plugin não desliga sozinha: o botão fica no grupo do plugin e liga e desliga ele inteiro, com os agentes e os servidores dele. Agentes não têm como desligar.
    - **A lixeira** leva as suas skills, comandos e agentes (a pasta da skill ou o arquivo) para a lixeira do edit.r (`~/.local/share/editr/claude-trash`, ou `CLAUDE_TRASH_DIR`), com **Desfazer** no pé da lista e **Restaurar** na lixeira, de onde voltam para o mesmo lugar. As do claude.ai, dos plugins e do Claude Code ficam de fora: as do claude.ai voltariam na próxima sincronização.
  - **Worktrees:** os worktrees de cada projeto, um grupo por repositório (só os que têm algum): os das conversas, os do `claude --worktree` e os criados à mão em qualquer pasta. Cada um mostra a branch, os arquivos sem commit, os commits que a base ainda não tem (um rebaseado conta como trazido), quantos ele está atrás, se é de fora das pastas de projetos ou se a pasta já foi apagada, e as conversas que estão nele, que abrem com um toque. Ele também tem as ações:
    - **Trazer:** o merge na branch de origem, o mesmo do botão da branch no chat.
    - **Conversa:** abre uma conversa nova dentro do worktree.
    - **Terminal:** abre um terminal na pasta dele, no PC.
    - **Apagar:** tira a pasta e, quando tudo dela já está na base, a branch. Com trabalho que não voltou, pede confirmação e diz o que se perde, e a branch com commits fica. Da pasta já apagada, sai só o registro no git.
  - **MCP:** os servidores, com o estado (conectado, falhou e por quê, precisa autorizar, desligado), de onde vem a configuração (seu, do projeto, só nesta pasta, do claude.ai, de um plugin), o comando ou o endereço e as ferramentas de cada um. Segredos não saem do PC: das variáveis e cabeçalhos aparece só o nome, e argumentos com cara de chave viram `•••`. Embaixo, **Ligados só em outras pastas** diz onde estão os que não valem ali. O Claude Code não tem desligar global para servidor: o botão aparece nos de plugin (liga e desliga o plugin inteiro) e nos que só existem na pasta pessoal; para desligar num projeto, use o `/mcp` numa conversa dele. A lixeira tira a configuração do servidor pelo próprio `claude mcp remove` (os seus, os da pasta pessoal; o **×** de cada pasta em **Ligados só em outras pastas** tira de lá) e a guarda, com os segredos, só no PC: **Restaurar** devolve igual, pelo `claude mcp add-json`. Autorizar continua sendo pelo `/mcp` num terminal, ou nos conectores do claude.ai.
  - Para saber o que vale, o PC pergunta ao próprio Claude Code: pela conversa do painel aberta na pasta, ou subindo um Claude Code só para isso, que leva alguns segundos. A resposta fica guardada por 10 min; **Atualizar** pergunta de novo.

Com várias máquinas (ver [Várias máquinas](#várias-máquinas)):
- As conversas de todas aparecem juntas, cada uma com o nome da máquina. No topo das Sessões, o filtro **Todas · máquina 1 · máquina 2** mostra só as de uma; a bolinha de cada máquina diz se a conexão com ela está de pé.
- O cabeçalho do chat diz a máquina, e tudo da conversa (mensagens, arquivos, git, `@`, comandos) vai para ela. Dá para pôr conversas de máquinas diferentes lado a lado.
- **Nova** pergunta primeiro a máquina e depois o projeto dela. **Projetos** e **Computador** mostram os da máquina escolhida no filtro.

O app se ajusta à tela:
- **Celular em pé:** uma tela por vez, com as abas embaixo.
- **Celular deitado:** o app instalado gira junto. As abas viram uma coluna na lateral, e o cabeçalho e a caixa de mensagem ficam mais baixos para sobrar espaço para a conversa; a branch continua no **⎇** do topo. Depois de atualizar, o Android pode levar até um dia para liberar a rotação no app instalado; reinstalar o app faz valer na hora.
- **PC ou tablet deitado** (a partir de 1024 px de largura, ou já de 768 px com mouse, como uma janela de PC na metade da tela): a lista de conversas fica fixa à esquerda, e a conversa aberta fica ao lado, marcada na lista. Trocar de conversa não precisa voltar à lista. Sem conversa aberta, o lado direito mostra **Nova conversa**.
  - À esquerda fica sempre a alça, uma barra estreita com o botão da lista de conversas (com o contador das que precisam de você), nova conversa, Início, Projetos e Computador e, embaixo, CPU, memória e os limites do Claude (5 h e semana). Com a lista aberta, essas medidas ficam no pé dela, uma por linha, com um traço fino em cinza que só ganha cor no alerta. Com a lista recolhida, voltam para a alça, empilhadas e no mesmo estilo: o valor, um traço curto e o nome. Passar o mouse numa medida mostra o detalhe, e clicar abre o painel Computador (as do Claude, direto no uso dele, em **Agentes**).
  - Ao lado da alça, a lista de conversas, só com a busca e as conversas. O botão do topo da alça recolhe e abre a lista, e a escolha fica salva. Com a lista recolhida, cabe mais uma conversa lado a lado.

Conversas lado a lado (split): **Abrir outra ao lado**, no menu ⋮ do chat, escolhe a conversa que divide a tela. No PC também dá pelo botão que aparece ao passar o mouse numa conversa da lista.
- Cabem 2 no celular: em pé, uma em cima da outra, e deitado, lado a lado. Digitando numa, a outra encolhe até o cabeçalho para o teclado não espremer as duas. Numa janela estreita e em pé no PC elas também ficam empilhadas, mas não encolhem ao clicar: o tamanho de cada uma é pela divisória.
- No PC, cabem conforme a largura da tela, até 4: 2 numa tela de 1280 px, 3 numa de 1440 px e 4 numa de 1920 px.
- **Tamanho:** arrastar a divisória entre duas conversas passa espaço de uma para a outra, até um mínimo de 300 px cada (as outras não mudam). Dois cliques na divisória voltam ao meio a meio, e com ela em foco as setas do teclado também mexem. O tamanho fica salvo por conversa.
- **Posição:** arrastar uma conversa pelo topo dela e soltar na metade esquerda ou direita de outra leva a conversa para lá; a metade onde ela vai cair fica marcada enquanto você arrasta. Arrumar a tela não entra no histórico do voltar.
- A conversa em foco tem uma faixa no topo, e as outras ficam atrás de um véu na cor do fundo, com o texto nítido mas com menos contraste, para a em foco saltar aos olhos; com o mouse em cima, o véu clareia. Tocar numa conversa a põe em foco, e o toque vale de primeira (um botão tocado nela já funciona); clicar noutra da lista troca a que está em foco.
- O **×** no cabeçalho tira a conversa da tela, e o voltar desfaz a última abertura ou fechamento.
- Cada conversa é um chat completo, com caixa de mensagem, arquivos, git e leitura em voz alta; a barra de leitura aparece na conversa que está sendo lida.

**Abas no PC**, como os grupos de editores do VSCode: cada lado da tela é um grupo, com a sua barra de abas, e cada aba é uma conversa ou um arquivo (ou o diff de um lado dele) aberto pela barra do projeto. No celular nada muda: lá vale o que está acima.
- **Abrir:** clicar numa conversa da lista (ou um link para ela, da home, da salinha ou de uma notificação) abre numa **aba de prévia** do grupo em foco, com o título em itálico, que o próximo clique troca; se a conversa já está aberta, só vai para a aba dela. A prévia vira aba fixa ao mandar uma mensagem nela ou com dois cliques (na aba ou na conversa da lista). Arquivos funcionam igual: um clique na árvore ou na aba Git abre como prévia, dois cliques deixam a aba.
- **Na aba:** o claudinho diz a situação da conversa (um balão de "…" quando o Claude executa algo, a mão no queixo quando ele pensa, um balão âmbar de "!" quando espera você e um joinha quando termina); o **×** e o botão do meio fecham; o botão direito tem **Fechar**, **Fechar as outras**, **Fechar as da direita**, **Manter aberta** (na prévia) e **Abrir ao lado**, que leva a aba para um grupo novo à direita.
- **Arrastar uma aba** muda a ordem na barra, a leva para a barra de outro grupo ou, solta na borda esquerda ou direita de um grupo, abre um grupo novo daquele lado (o meio leva para aquele grupo). Grupo que fica sem abas some. Cabem tantos grupos quanto conversas lado a lado.
- O grupo em foco tem a faixa na aba ativa, e os outros ficam atrás do véu. Ao abrir o app, só as abas à vista carregam; as outras esperam até aparecer pela primeira vez. Depois disso continuam abertas por baixo, sem custar pintura: voltar a uma mantém a rolagem, o rascunho e o que ela mostrava.
- A URL diz a conversa em foco, e as abas ficam salvas neste aparelho: recarregar, ir à home e voltar mantém tudo como estava. Fechar a última aba volta para a home. Em modo zen, só a conversa dele fica, sem as abas.

Notificações, mesmo com o app fechado, depois de ativadas no painel Computador:
- **Sempre:** quando o Claude faz uma pergunta (com as opções), pede aprovação (com o comando ou o arquivo) ou a sessão cai.
- **Quando terminar** (opcional): com o começo da última resposta do Claude.
- **Sessões abertas no PC** (opcional): quando uma sessão do terminal ou do VSCode passa a esperar você, ou termina algo que levou mais de 1 min.
- **Sons no app** (cartão **Sons**, no painel Computador): com o app aberto, toca um som quando qualquer conversa passa a perguntar algo ou pedir aprovação (duas notas subindo) e outro quando termina (três notas descendo); das sessões abertas no PC, o de fim só depois de algo que levou mais de 1 min. Cada um liga e desliga separado, com **Ouvir** para conhecer. Os sons são gerados no próprio navegador, sem arquivo de áudio. Com o app na tela, a notificação chega sem som, porque o app já tocou o dele; em segundo plano, quem avisa é a notificação. O navegador só libera o som depois do primeiro toque no app.
- **Título da aba:** enquanto alguma conversa espera você (uma pergunta ou uma aprovação, no painel ou numa sessão aberta no PC, em qualquer máquina), o título da aba vira "(2) Esperando resposta · edit.r", com quantas são. Dá para ver de outra aba, sem som nem notificação, e volta a ser só "edit.r" quando a última é respondida. É o mesmo sinal do som de atenção.
- **Fundo da conversa** (cartão **Fundo da conversa**, no painel Computador): um desenho em ASCII animado atrás da conversa. Ele ocupa a área central inteira — não a alça nem a lista ao lado, e o cabeçalho de cada conversa fica opaco por cima dele —, e é uma cena só: com conversas lado a lado o fundo atravessa a divisória em vez de recomeçar em cada uma. A barra de mensagem fica por cima dele, de vidro. Com uma foto sua atrás (as cenas em caracteres dispensam), um véu escurece a janela inteira por dentro, por igual, de lado a lado e até o fim da tela por trás da barra, para as letras ficarem legíveis: no escuro ele é preto, no claro tem a cor do fundo do app. O mapa mental também deixa a cena aparecer, sob o mesmo véu, no lugar do chat ou ao lado dele, a inbox também, numa aba do PC, com o véu atrás da lista e o topo de vidro como a aba aberta, o arquivo ou o diff aberto como aba, com o véu atrás do código, e a mesa do projeto, com os blocos de vidro. O quanto ele escurece se ajusta no controle **Escurecer**, de 0 a 90%, separado da força da cena; quem já usava começa com o que a força dava antes. São catorze temas, escolhidos por miniaturas que são a própria cena rodando:
  - **Água:** **Aquário** (cardume atravessando, algas no rodapé e os grandes comendo os pequenos), **Lagoa das Tartarugas** (honu planando, uma raia ao fundo e a rede de luz das cáusticas tremendo por cima), **Lago das Carpas** (o lago visto de cima, carpas coleando e vitórias-régias boiando), **Água-viva** (campânulas que apertam para subir e afundam devagar) e **Barquinhos de Papel** (barcos atravessando, com o reflexo tremendo embaixo).
  - **Céu:** **Nuvens**, **Aurora** (cortinas de luz entre o verde e o violeta), **Galáxia** (três camadas de estrelas em paralaxe, nebulosa e riscos cruzando) e **Luar** (a lua, nuvens finas na frente dela e o caminho de luz na água).
  - **Casa:** **Vaga-lumes** (mato em moitas e pontos acendendo fora de compasso, cada um com um halo nas vizinhas), **Jardim Sakura** (galho florido e pétalas girando enquanto caem) e **Chuva Lo-fi** (chuva na janela e gotas escorrendo no vidro).
  - **Tela:** **Chuva de Código**.
  - **Som do PC:** obedece ao que está tocando nas caixas — o espectro em barras no rodapé, com o pico de cada faixa caindo devagar por cima, como o mostrador de um aparelho de som. Com o PC mudo elas descansam no zero. Quem escuta é o PC, pelo monitor do sink padrão do PipeWire/PulseAudio (então acompanha a saída que você escolher), e só enquanto a cena está na tela: o `parec` nasce quando alguém abre o tema e morre quando o último sai. Do celular o desenho atrasa uns 30–80 ms em relação ao som, o que não se nota num fundo. Precisa do `parec` (pacote `libpulse`) e de o servidor de som estar rodando para o usuário do serviço; se faltar, o cartão avisa.

  A **intensidade** (sutil, médio ou forte) é o quanto o fundo aparece atrás do texto. Cada tema tem uma versão para o tema claro e outra para o escuro, para o texto da conversa continuar legível nos dois. A escolha é deste aparelho e fica guardada nele, como os sons: dá para deixar o celular com o aquário e o PC limpo.
  - **Custo:** cada par (caractere, cor) é rasterizado uma vez só num atlas, e desenhar uma célula vira um blit; de um quadro para o outro só as células que mudaram são repintadas, o que na prática dá menos de 100 delas a 12 quadros por segundo. O degradê e os raios de luz são CSS atrás do canvas, de graça. Cenas de massa (água, nuvem, chama) pintam também um bloco na cor do glifo atrás dele: sem isso, um caractere de pouca tinta como `.` ou `·` vira dois ou três pixels antialiasados e some. Fora da tela (conversa ao lado recolhida) ou com o app em segundo plano o laço é cancelado, não só ignorado, e com **reduzir movimento** ligado no sistema fica um quadro parado. Em tela grande o caractere cresce em vez de a grade multiplicar. O desfoque das superfícies de vidro só existe com um tema escolhido e dentro da conversa: sem cena atrás, borrar uma cor chapada custaria GPU para não mudar nada na tela.
- Cada conversa tem uma notificação só, e a mais nova substitui a anterior. Tocar abre a conversa; abrir a conversa limpa o aviso; a conversa que já está na tela não avisa.
- O aviso chega mesmo com o Tailscale desligado no celular, mas abrir a conversa precisa dele. No Android, vale ligar a **VPN sempre ativa** do Tailscale.

No chat:
- **Bifurcar daqui:** o ícone ao lado de cada mensagem sua abre uma conversa nova com o histórico só até antes dela, e devolve o texto ao campo para você reescrever e seguir por outro caminho. A original fica intacta na lista, então dá para comparar as duas respostas depois. É o mesmo que editar uma mensagem antiga no ChatGPT. O corte vai até o último registro do turno que fica de pé, e o Claude Code retoma a conversa só até ali.
  - A bifurcação se identifica: um ícone de ramo antes do título, na lista e no cabeçalho do chat, e uma tarja no alto da conversa dizendo de qual ela saiu — tocar nela abre a original.
  - O Claude Code só grava o arquivo da conversa bifurcada no primeiro turno dela. Até lá (e depois, se ela for fechada antes disso) o painel mostra o histórico herdado da origem, cortado no ponto, só para consulta. De onde cada bifurcação saiu fica gravado em `~/.local/state/editr/meta.json`, porque o vínculo precisa durar mais que o processo.
- **De onde saiu cada mensagem:** embaixo de cada mensagem sua aparece por onde ela entrou, de que máquina e quando: "Terminal · valb · 22:41", "VSCode · valb · ontem 10:03", "edit.r · pixel-8 · 09:12". O ícone diz se foi pelo terminal, pelo VSCode, por um celular ou por um computador; passar o mouse mostra a data inteira. É isso que substitui o antigo **Assumir**: a conversa vai do terminal para o celular e volta, e o histórico conta o caminho.
  - Terminal e VSCode são sempre o próprio PC, e a hora vem do registro da conversa no Claude Code. Do app, o nome do aparelho vem do Tailscale: o `tailscale serve` repassa o IP de quem acessa, e o `tailscale status` diz de que máquina ele é (pelo nome do MagicDNS, o mesmo do painel do Tailscale). Aberto no próprio PC, em `127.0.0.1`, é o nome dele.
  - O Claude Code não grava de que aparelho a mensagem veio, então o edit.r dá a ela o próprio UUID e guarda o aparelho e a hora do envio em `~/.local/share/editr/origins.jsonl`. Mensagens do app de antes disso aparecem só como "edit.r" e a hora.
- **Modo zen** (o botão de recolher, no topo da conversa): deixa a conversa sozinha na tela — somem a alça, a lista e o cabeçalho, ficam só as mensagens e a caixa de escrever. É da conversa em que foi ligado: com outras lado a lado, elas saem de vista, sem fechar nem perder o que estava escrito, e voltam quando ele desliga. Para sair, o botão apagado no canto de cima, o Esc no PC ou o voltar do celular. A escolha fica salva neste aparelho.
- O menu ⋮ tem **Fixar no topo**, **Renomear**, **Resumo da sessão** e **Apagar conversa**. O título é gravado no próprio Claude Code, então aparece também no `/resume` do terminal e no VSCode. Apagar remove o histórico de vez e é recusado se a conversa estiver aberta no PC.
- **Sua mensagem fixa no topo:** quando a sua mensagem sobe e sai da tela, ela fica numa faixa logo abaixo do cabeçalho (até duas linhas), para você não perder o que pediu enquanto lê a resposta. Subindo até a resposta anterior, a faixa troca para a mensagem de lá; com a mensagem à vista, a faixa some. Mensagem curta: tocar leva até ela. Mensagem que não cabe nas duas linhas (com a ⌄): tocar abre ela inteira ali mesmo, rolando dentro da faixa até metade da tela, sem tirar você do ponto da resposta; embaixo, **Ir até a mensagem** e **Recolher**.
- **Perguntas do Claude:** as opções vêm numa lista só, com o círculo (escolha única) ou o quadrado (várias), e a que o Claude sugere ganha o selo **Recomendado**. A última linha, **Outra resposta**, é para escrever a sua: escrever ali desmarca as opções, e marcar uma opção apaga o texto. Com várias perguntas, cada uma tem a sua aba, com ✓ quando respondida; escolher numa de escolha única já leva à próxima que falta, e **Responder** só libera com todas respondidas.
- Em chats com projeto, a branch aparece inteira embaixo da caixa de mensagem, e o topo tem estes botões:
  - **GitHub** (se o projeto tem remoto): abre a página do repositório; no Android, abre o app do GitHub se estiver instalado. Em outros serviços, como o GitLab, o ícone é um link genérico.
  - **Barra do projeto** (no PC, a alça da direita; no celular, o botão de painel no topo, com quantos arquivos o git vê alterados): abre os arquivos e o controle de código-fonte do projeto, como a barra lateral secundária do VSCode. No PC, o topo diz de que projeto ela é: a marca e o nome dele (numa conversa em worktree, o nome da cópia ao lado) e o nome da aba aberta; botão direito ali abre o menu do projeto, o de escolher a logo. Ela tem duas abas:
    - **Arquivos:** a árvore de pastas e arquivos, só para leitura, com o que o git ignora esmaecido e as cores do git: o nome e a letra de cada arquivo alterado (**M** modificado, **U** novo, **A** adicionado, **D** apagado, **R** renomeado, **!** em conflito) e um ponto nas pastas com alteração dentro. Ela se relê quando o Claude termina um turno, e tem botões para atualizar e recolher as pastas.
    - **Buscar** (Ctrl+Shift+F): texto em todos os arquivos do projeto, como o "Buscar" do VSCode, com **maiúsculas**, **palavra inteira** e **regex**. Não há índice: o PC roda o [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) na hora, respeitando o `.gitignore` e pulando binários e arquivos acima de 1 MB; sem o `rg` instalado, a aba avisa. Os achados vêm por arquivo (até 2 mil); tocar num abre o arquivo naquela linha, com o trecho selecionado, e dois cliques deixam a aba fixa. Com um trecho de uma linha selecionado, o Ctrl+Shift+F já o põe no campo, e a busca fica guardada por projeto.
    - **Abrir arquivo pelo nome** (Ctrl+P, ou o botão de lupa no topo da aba Arquivos): a paleta busca no nome e no caminho, com a mesma lista da menção `@`; `caminho:12` abre já na linha 12, e sem nada digitado aparecem os arquivos do projeto abertos em abas. ↑↓ escolhem, Enter abre (Ctrl+Enter, como aba fixa).
    - **Git:** a branch, quanto está à frente e atrás do upstream, a mensagem e o **Commit**, e as listas **Alterações preparadas** e **Alterações**, com as linhas colocadas e tiradas de cada lado. No PC, os botões de cada arquivo aparecem ao passar o mouse; no toque, ficam sempre à vista. **+** prepara (stage) e **−** tira da preparação, um arquivo ou a lista toda. Ctrl+Enter na mensagem faz o commit. Sem nada preparado, o botão vira **Commit de tudo**. As setas sincronizam com o remoto: trazem o que chegou, só avançando, sem um merge escondido, e enviam o que falta. Numa branch sem upstream, elas publicam a branch no `origin`. Quando não há nada para o commit e há commits para enviar ou trazer, o botão grande vira o de sincronizar. Descartar alterações fica de fora de propósito, por ser a única ação que não teria volta. Se o git recusar (um hook que falhou, um pull que precisaria de merge), o aviso mostra o que ele disse.
    - Tocar num arquivo abre o conteúdo, com números de linha, opções de quebrar linhas e de ver Markdown formatado; imagens aparecem direto e PDFs abrem à parte. No celular ele abre só para leitura; no PC, no editor (abaixo). Numa alteração, abre o diff daquele lado, com o número antigo e o novo de cada linha, e o **Abrir arquivo** leva ao arquivo inteiro.
    - **Editor de código (no PC):** o arquivo aberto como aba é editável, num editor simples no jeito do VSCode, sem LSP nem indexação do projeto. É o [CodeMirror 6](https://codemirror.net), que baixa só quando um arquivo abre (uns 40 KB) e fica fora do cache offline: sem rede, o arquivo abre só para leitura, como antes.
      - **Escrever:** cursor que desliza e pisca suave (o *smooth caret* do VSCode), desfazer e refazer, vários cursores (Ctrl+D pega a próxima ocorrência, Alt+clique põe outro cursor, Shift+Alt+arrastar seleciona em coluna), Alt+↑/↓ move a linha, Ctrl+/ comenta, fecha parênteses e aspas, dobra blocos pela margem e acerta a indentação pelo que o arquivo já usa (tab ou espaços). Ctrl+F busca e Ctrl+H substitui, com maiúsculas, regex e palavra inteira. Ctrl+G vai para uma linha, e Ctrl+Shift+O para uma função, classe, método ou tipo do arquivo (no Markdown, um título), tirados do próprio parser, sem LSP. Ao digitar, o autocomplete sugere as palavras do arquivo e o que a linguagem já sabe sem LSP (os nomes do escopo, as palavras-chave, as propriedades do CSS); Tab ou Enter aceitam.
      - **Rodapé:** com um arquivo em foco, a barra de status mostra a linha e a coluna (clicar abre o "ir para a linha"), quanto está selecionado, a indentação, a quebra de linha (LF ou CRLF) e a linguagem, como no VSCode.
      - **Salvar:** Ctrl+S, ou o **Salvar** que aparece no topo quando há alteração. A aba ganha um ponto no lugar do X, e uma prévia vira aba fixa ao escrever nela. Fechar uma aba com alteração pergunta **Salvar**, **Não salvar** ou **Cancelar**. O que não foi salvo fica guardado no aparelho (IndexedDB) a cada pausa na digitação: recarregar a página, fechar o app ou levar a aba para outro grupo não perde nada, e a aba volta com o ponto e o texto. Se o arquivo mudou no disco enquanto isso, a faixa de conflito pergunta o que fazer. Salvar conta como tempo de código no WakaTime.
      - **O Claude mexeu no arquivo:** o editor acompanha o arquivo no disco. Sem nada por salvar, o texto novo entra sozinho, com um lampejo nas linhas que mudaram, e o cursor e a rolagem ficam onde estavam. Com alteração sua, uma faixa avisa e pergunta: **Recarregar** (fica o do disco) ou **Manter o meu** (o próximo salvar grava por cima). Salvar nunca apaga uma mudança que você não viu: se o arquivo mudou desde que abriu, o PC recusa e a mesma faixa aparece. O que mudou fica marcado com uma barra laranja (a cor do Claude), numa coluna à esquerda das marcas do git, até você ver: clicar nela abre o antes e o depois ali mesmo, com as setas para a próxima e o **Visto**, que tira a marca. Não dá para saber quem gravou, então a marca diz "mudou no disco": o Claude, outro editor ou um `git checkout`.
      - **Git:** as marcas na margem (verde, linha nova; azul, mudada; triângulo vermelho, linhas que saíram) comparam o que está escrito com o último commit enquanto você digita, e acompanham um commit feito pela barra. Clicar numa marca abre a mudança ali mesmo, com o antes e o depois. As setas do topo e F7 / Shift+F7 vão de mudança em mudança.
      - **Erros de sintaxe:** o próprio editor sublinha, só no trecho na tela, o que não fecha ou sobra (uma chave, um parêntese), sempre a palavra inteira. Como a extensão Error Lens do VSCode, a linha do erro fica levemente vermelha e a mensagem aparece no fim dela, com o botão **Pedir ao Claude**, que põe no campo da conversa a linha e o erro; o mesmo botão está na dica do sublinhado.
      - **Mencionar e pedir ao Claude:** o botão direito abre o menu com **Mencionar no chat** (as linhas selecionadas, ou a clicada), os pedidos ao Claude, recortar, copiar e colar; Ctrl+Alt+K e o **@** do topo mencionam a seleção. Os pedidos (**Explicar**, **Refatorar**, **Escrever testes**, **Achar bugs** e **Outra coisa…**) põem no campo da conversa a menção às linhas com o pedido escrito, sem mandar: dá para ajustar antes. Ctrl+I abre esses pedidos num menu no lugar do cursor, sobre a seleção ou a linha dele. Com alteração por salvar, o editor grava antes, para o Claude ler o mesmo texto que está na tela.
      - As cores são as do GitHub, como no resto do app, mas quem colore no editor é o parser dele (Lezer), que relê só o trecho editado; o tom de uma ou outra parte do código pode sair diferente do diff. Arquivo maior que 1 MB abre só para leitura.
    - **Mencionar no chat:** o botão direito num arquivo ou pasta, na árvore ou na aba Git (no celular, segurar o dedo), abre o menu com **Mencionar no chat**, **Abrir** e **Copiar caminho**. Mencionar põe `@caminho` (`@pasta/`, numa pasta) onde estava o cursor do campo de mensagem da conversa em foco e deixa o cursor logo depois, pronto para continuar escrevendo; no PC, a aba da conversa vem para a frente; no celular, o arquivo aberto e a folha fecham. O **@** no topo do arquivo aberto faz o mesmo.
    - **Mencionar um trecho do código:** no arquivo ou no diff aberto, a seleção é de linhas e é do próprio app, como num editor; a do navegador apagava quando o menu abria. No PC, arrastar seleciona, clicar no número da linha escolhe aquela linha, Shift+clique estende, Ctrl+C copia as linhas e Esc limpa a seleção. O botão direito abre o menu, e a seleção continua destacada enquanto ele está aberto: **Mencionar no chat** põe `@caminho#L10-20` no campo de mensagem, o mesmo formato do Alt+Ctrl+K da extensão do VSCode, que o Claude Code lê como aquelas linhas do arquivo; **Copiar** copia o trecho, e **Pedir ao Claude** traz os mesmos pedidos do editor (explicar, refatorar, escrever testes, achar bugs). Botão direito fora da seleção vale a linha clicada (`#L12`). No diff, contam as linhas do arquivo novo; as tiradas ficam de fora. No celular, tocar no número da linha a escolhe e tocar em outro estende; segurar o dedo numa linha também a escolhe, e mexer o dedo continua rolando. Com linhas escolhidas, aparece no rodapé **Mencionar linhas 10–20**, com copiar e soltar. Os números da margem não entram no que se copia.
    - **Tamanho da fonte do código**, no arquivo e no diff: os botões **A↓** e **A↑** no topo, Ctrl+= e Ctrl+− (Ctrl+0 volta aos 12 px), Ctrl+roda do mouse no PC e a pinça no celular, de 9 a 24 px. A linha que estava no topo continua no topo, e o tamanho fica salvo neste aparelho.
    - **Cores de sintaxe** no arquivo e no diff, as do GitHub: o [Shiki](https://shiki.style), com as gramáticas do próprio VSCode e o tema do GitHub de hoje (claro ou escuro, conforme o tema do app), sobre o fundo do próprio app. O código, os comandos e o terminal usam a fonte [Cascadia Code](https://github.com/microsoft/cascadia-code), com ligaduras; o terminal usa também as cores do GitHub. No diff, os dois lados são coloridos cada um de uma vez, para uma linha no meio de um comentário ou de uma string longa sair com a cor certa. São 37 linguagens (TypeScript, JavaScript, Python, Rust, Go, Java, Kotlin, C, C++, C#, PHP, Ruby, Dart, Lua, shell, SQL, HTML, CSS, Vue, Svelte, Astro, Markdown, JSON, YAML, TOML, Dockerfile, Makefile, `.env`, entre outras). O Shiki e cada gramática só baixam quando um arquivo daquela linguagem é aberto, e ficam fora do cache offline do app; sem rede, ou num arquivo com mais de 5 mil linhas, ele aparece sem cores.
    - No PC, uma alça fica sempre na borda direita enquanto a conversa tem projeto, como a da esquerda: o botão do topo abre e recolhe a barra, e os ícones embaixo são as abas, **Arquivos** e **Git** (com quantos arquivos estão alterados); tocar no ícone da aba aberta recolhe a barra, como no VSCode. Aberta, a barra fica entre as conversas e a alça, com o nome da aba no topo, e mostra o projeto da conversa em foco: com conversas lado a lado, ela troca quando você clica noutra. A divisória muda a largura (dois cliques voltam aos 320 px), e a largura, a aba e se a barra está aberta ficam salvas. O arquivo ou o diff abre como aba (ver **Abas no PC**). Quando a janela não tem espaço para as conversas na largura mínima e a barra ao lado, ela abre por cima, como folha. No modo zen ela some.
    - No celular, o botão de painel no topo da conversa abre a barra como folha pela direita, com as abas no topo dela, e o arquivo abre em tela cheia. O voltar fecha primeiro o arquivo e depois a folha. Lado a lado, tocar no botão de uma conversa fora de foco, com a barra aberta, só traz o projeto dela.
- **Terminal** (no PC, pelo botão **Terminal** da barra de status): o painel de baixo abre o shell do PC, como o terminal integrado do VSCode.
  - **Abas:** o **+** abre outro terminal na pasta da conversa ou do projeto em foco; cada aba mostra a pasta em que o shell está (acompanha o `cd`) e uma bolinha laranja enquanto um comando roda, vermelha se o último falhou. Trocar de conversa nas abas de cima não troca de terminal. O **×** ou o botão do meio fecha a aba e encerra o shell; fechar a última fecha o painel.
  - **Copiar e colar:** Ctrl+C copia o que está selecionado (sem seleção, interrompe o comando, como sempre) e Ctrl+V cola; Ctrl+Shift+C/V e Ctrl/Shift+Insert também valem.
  - **O shell continua no PC:** travar o app, recarregar a página, a rede piscar ou fechar o navegador não encerra nada. Ao voltar, a aba reconecta sozinha ao mesmo shell e recebe o que saiu enquanto isso (até 1 MB); um programa de tela cheia, como o vim, se redesenha. Um terminal sem nenhum aparelho ligado por 24 h é encerrado, e reiniciar o edit.r encerra todos (a aba abre um novo na mesma pasta).
  - Cada comando vira um bloco, com a pasta e a branch no cabeçalho e, à direita, ✓ ou ✗ com o código de saída e quanto levou.
  - **Salvos:** uma mini barra à direita do terminal, que liga e desliga no cabeçalho do painel, guarda os comandos que você roda sempre, deste projeto ou globais (`git pull --rebase` em qualquer pasta). Os fixados ficam no alto. Tocar roda o comando na aba à vista; se ela estiver ocupada (um `pnpm dev` rodando), abre outra aba na mesma pasta e roda lá. O **⋯** tem rodar numa aba nova, colar sem rodar, editar e mandar para a lixeira, com **Desfazer** ali mesmo e **Restaurar** no pé da barra (o que passa de 30 dias some sozinho).
    - **Sugestões:** a barra já traz o que a pasta oferece e ainda não foi salvo: os scripts do `package.json` mais perto, com o gerenciador do lockfile ou do `packageManager` (`pnpm dev`, `yarn build`, `npm run test`; os ganchos como `postinstall` ficam de fora), os alvos do `Makefile` (com `make -C` quando ele está numa pasta acima) e os comandos dos workspaces do projeto. Tocar roda; salvar ou fixar é um toque.
    - O projeto é o repositório da pasta da aba (um worktree conta como o projeto de origem); fora de um, só os globais. Eles ficam guardados no PC, em `~/.local/share/editr/commands.json` (`COMMANDS_FILE`), e aparecem em qualquer aparelho.
- A caixa de mensagem segue o formato da extensão do VSCode: o texto em cima e, na mesma caixa, uma linha com:
  - **+**: enviar do celular (câmera, galeria, arquivos) ou adicionar contexto com `@`;
  - **/**: comandos e skills;
  - **anel de contexto**: quanto falta para a compactação automática, com **Compactar agora**;
  - **pílula do modelo**: com o esforço;
  - **modo**: Manual, Editar automaticamente, Plano ou Automático, com o nível de esforço no mesmo menu;
  - **enviar**: muda de cor conforme o modo, e vira **parar** enquanto o Claude trabalha, com o campo vazio. Com texto, a mensagem entra na fila.
- Embaixo de cada resposta do Claude ficam a marca do Claude com o modelo e o esforço que a escreveram e, no PC, ao passar o mouse sobre ela, **Ouvir** e **Copiar** (a resposta em Markdown); no celular, sem mouse, os dois ficam sempre à vista. **Ouvir** lê o texto em voz alta com a voz do próprio celular; nada roda no PC. No PC, com o Piper instalado, a voz é a dele (ver [Voz natural no PC](#voz-natural-no-pc-piper)). Blocos de código e tabelas viram um aviso ("Tem um trecho de código na tela"), caminhos viram só o nome do arquivo e links viram "um link". Durante a leitura:
  - como a letra no Spotify, o trecho sendo lido fica em destaque, o resto da resposta esmaece e a conversa rola junto;
  - em cima da caixa de mensagem aparece uma barra com pausar/continuar, a frase atual e até onde já leu; tocar ou arrastar na barra pula para outra frase, e o **×** encerra;
  - o botão embaixo da resposta também pausa e continua (continuar repete a frase desde o começo), e tocar em outra resposta troca a leitura.
  - o **1x** da barra troca a velocidade: 1,5x, 2x, 3x e de volta a 1x. A escolha fica salva no celular e vale para todas as conversas, inclusive na leitura automática; trocar no meio de uma frase recomeça a frase já na velocidade nova (com o Piper, a voz muda de ritmo na hora). A voz acelera sem ficar fina, mas o máximo real depende da voz do aparelho: algumas param de acelerar antes de 3x.
  - Com a tela apagada, o Android pode cortar a fala: a leitura fica pausada na frase em que parou, e **Continuar** retoma.
- O alto-falante no topo do chat liga a **leitura automática**: cada resposta nova do Claude é lida sozinha, sem tocar em **Ouvir**. Uma resposta que chega com outra sendo lida espera a vez, e o histórico nunca é lido. A escolha é de cada conversa: com duas lado a lado, ligar numa não lê a outra, e desligar cala só o que for dela. Fica salva no celular.

  No Android, a voz é a de **Configurações › Acessibilidade › Saída de texto para fala** (o nome muda conforme a marca do celular): escolha **Serviços de fala do Google**, idioma Português (Brasil), e baixe a voz para ela funcionar sem internet.
- Nas respostas, como no VSCode, cada cor escrita (`#d97757`, `rgb(…)`, `hsl(…)`, `oklch(…)`) ganha um quadradinho com a cor, no texto e no código; fora do código, `#78` e `#123` ficam como estão, porque costumam ser PR ou issue. Ao lado de cada link e de cada comando citado (`npm i …`, `git push`, `$ …`), um ícone copia o endereço ou o comando.
- Na última resposta de cada turno (da sua mensagem até o fim da resposta), ao lado do modelo, aparecem atalhos do que o Claude fez nele, quando houver: **arquivos**, **comandos** e **links**. Cada um abre o seu modal, uma ilha como a do TODO, com a contagem no alto. Com mais de 5 itens, o modal ganha uma busca (sem acento nem maiúscula) e filtros, que só aparecem quando separam alguma coisa:
  - **Arquivos**, com as linhas colocadas e tiradas; tocar mostra o diff de cada edição e os botões **Abrir** (o arquivo no projeto), **Mencionar** (o `@caminho` na caixa de mensagem) e copiar o caminho. Filtro por extensão. Entram as mudanças feitas pelas ferramentas de edição do Claude (Edit, Write); arquivos mudados por um comando (um script, um formatador) aparecem só em **Comandos**.
  - **Comandos** do terminal, com ✓ ou ✗ e quanto levou; tocar mostra o comando, a saída e o **Copiar**. A busca acha também pela saída; filtros **Falharam**, **Testes** e **Rodando**.
  - **Links**: as páginas que o Claude acessou (a mesma página aberta duas vezes conta uma), as pesquisas que fez na web e os links citados na resposta, cada link com o botão de copiar. Filtros **Citados**, **Abertos** e **Pesquisas**.
- **Subagentes:** quando o Claude delega parte do trabalho (a ferramenta Agent), cada subagente vira uma linha no bloco de ações, com a tarefa e, embaixo, o que ele está fazendo agora; ao terminar, o começo do relatório. O que ele faz por dentro (ferramentas, falas) não se mistura ao chat: fica na conversa dele. As aprovações pedidas por um subagente dizem de qual subagente vieram.
  - **Trilho de agentes:** uma aba que sai da borda esquerda do chat, logo abaixo do cabeçalho, na cor da moldura em volta da conversa, com o claudinho da conversa no alto e, embaixo, um claudinho por subagente, na ordem em que foram chamados (o membro do time aparece com o claudinho dele; os chamados por outro subagente, um pouco menores). Quem trabalha pisca, quem pede aprovação ganha um ponto âmbar, quem falhou um ponto vermelho, e quem já terminou fica um tom mais apagado. A aba tem a altura do que tem dentro e, com muitos subagentes, rola por dentro; quando um subagente começa a trabalhar, ela rola até ele. Conversa sem nenhum subagente não tem trilho.
  - Tocar num subagente (no trilho, na linha dele no chat ou no mapa mental) põe a conversa dele em foco, no lugar do chat: no alto, quem ele é, o tipo, as ferramentas usadas, o tempo, o estado e quem o chamou; embaixo, o pedido que recebeu, como a primeira mensagem, o passo a passo e o relatório final como resposta. Enquanto ele trabalha, a última linha diz o que está fazendo agora (com um resumo do andamento a cada ~30 s); pedindo aprovação, **Responder no chat** leva ao cartão de responder. Em conversas do histórico ou abertas no PC, o passo a passo vem do registro salvo no PC.
  - O claudinho da conversa, no alto do trilho, o X, o Esc no PC e o voltar do celular saem do foco. O chat continua montado por baixo, então volta onde estava, e a caixa de mensagem segue falando com a conversa principal.
  - Subagentes em segundo plano continuam depois do fim da resposta: enquanto trabalham, a conversa segue como **Executando**, com "N subagentes" na lista de conversas, e **Liberar para o PC** espera eles terminarem. Com a conversa aberta no painel, **Parar**, no alto da conversa do subagente, encerra ele (o Claude recebe o aviso).
- **Protótipos do Claude:** quando o Claude publica uma página no claude.ai (a ferramenta Artifact do Claude Code, que sobe um HTML do PC), o chat mostra um cartão com o título dela, à vista mesmo com o bloco de ações fechado. **Abrir** mostra a página numa aba de navegador do app (no celular, em tela cheia, com o voltar), e a marca do Claude ao lado leva ao artifact no claude.ai. O claude.ai não deixa a página dele ser embutida em outro site, então a aba mostra o arquivo do PC, que é o mesmo que foi publicado: no alto, uma barra de navegador com recarregar, o caminho do arquivo, **claude.ai** e **Abrir numa janela**. Com a aba à vista, quando o Claude mexe no HTML (ou no CSS e nos scripts ao lado dele), ela recarrega sozinha. Qualquer `.html` do projeto também abre assim: **Abrir como página** no menu do arquivo, ou **Página** no arquivo aberto. A página roda isolada: ela carrega os arquivos da pasta dela (nunca os ocultos, como `.env` e `.git`) e o que buscar na internet, mas não alcança a API do edit.r nem o que o app guarda. Um HTML solto na pasta pessoal ou no `/tmp` abre sozinho, sem a pasta em volta; fora da pasta pessoal, das pastas de projetos e do `/tmp`, não abre. Nas conversas do painel a ferramenta vem ligada: o Claude Code a deixa desligada quando sobe pelo SDK, e o edit.r liga com `CLAUDE_CODE_ARTIFACT=1` (com `CLAUDE_CODE_ARTIFACT=0` no ambiente do serviço, ela fica desligada). Ela ainda depende da conta: login do claude.ai, plano que tenha artifacts e `enableArtifact` não desligado nos ajustes do Claude Code.
- **Artefatos:** a página que o Claude publica pelo MCP do edit.r (`publicar_artefato`), no lugar de um HTML solto: um protótipo, um relatório, um painel. Cada publicação congela o HTML e os arquivos que ele usa por caminho relativo (CSS, scripts, imagens e fontes da mesma pasta, seguindo também o que o CSS e os scripts citam; nunca os ocultos, nem o que fica fora da pasta, até 20 MB e 500 arquivos) numa versão que não muda mais. Publicar o mesmo arquivo de novo cria a versão seguinte do mesmo artefato; sem mudança nenhuma, fica a atual. Publicar não pede aprovação: o artefato só aparece na sua tailnet.
  - **No chat:** a publicação vira um cartão, à vista mesmo com o bloco de ações fechado, com o título, a versão e o arquivo, **Abrir** e, no `⋯`, **Copiar link** e **Ver em Artefatos**. Várias publicações do mesmo artefato num bloco viram um cartão só, o da última.
  - **A aba:** no PC o artefato abre numa aba de navegador como a dos protótipos (no celular, em tela cheia, com o voltar), com recarregar, o título, a versão (o menu troca para as outras, da mais nova à mais antiga), copiar o link e **Abrir numa janela**. A página roda isolada, como a dos protótipos.
  - **A galeria:** **Artefatos**, ao lado das Habilidades no cabeçalho do projeto, no pé da alça do PC, na paleta de comandos e no `⋯` dos cartões. À esquerda, os artefatos por projeto, com o claudinho da conversa que publicou, a versão e quando; à direita, a prévia, a descrição, as versões (tocar abre aquela), o link e o **Link público**. Apagar manda para a lixeira, com **Desfazer** ali mesmo; no pé da lista, a lixeira, com **Restaurar** e apagar de vez. O que passa de 30 dias lá some sozinho, com as versões.
  - **O link fixo:** `https://<máquina>.ts.net/a/<id>/` abre o artefato em qualquer aparelho da tailnet, sem o PIN (o id aleatório é a credencial), sempre na versão mais nova, numa barra no jeito do edit.r com o menu das versões; `/a/<id>/v/<n>/` fixa uma versão.
  - **O link público:** só você liga, no interruptor da galeria (a ferramenta não tem como). O edit.r liga o Tailscale Funnel na porta 8443 quando o primeiro artefato fica público e desliga quando não sobra nenhum. Quem tem o link vê a versão de quando ele foi ligado, numa casca sem nada do app: publicar de novo não muda o que está na internet até você tocar em **Publicar vN**. Desligar revoga o link (ligar de novo dá outro), e mandar para a lixeira também. Por trás fica um servidor à parte, só em `127.0.0.1`, que serve apenas os artefatos públicos: nada da API, do app ou do PIN passa por ele. A tailnet precisa permitir o Funnel (ver a política de acesso no painel do Tailscale); sem isso, o interruptor volta desligado com o motivo.
  - Os artefatos ficam em `~/.local/share/editr/artefatos.json` (`ARTEFATOS_FILE`), com as versões em `artefatos/<id>/v<n>/` ao lado.
- **Workspaces:** um molde de conversa, como uma gem. Cada workspace junta projetos (o primeiro é o principal, onde a conversa aberta pela página dele começa; os outros entram como pastas que o Claude também pode ler e editar), um texto de contexto, arquivos, regras, comandos de build, teste e lint e um time padrão. A página dele (uma aba no PC, sobre o fundo escurecido como o hub; uma tela no celular) edita tudo isso em blocos: o nome e a cor no alto, com **Nova conversa**; no PC, o contexto, as regras, os comandos e os arquivos de um lado e, do outro, os projetos (o `⋯` de cada um faz principal, faz padrão do projeto, abre o hub ou tira), o time padrão e as conversas dele. Ctrl+S salva, Enter numa regra abre a próxima e dá para soltar arquivos no bloco deles. Apagar o workspace fica no `⋯` do alto.
  - **Workspace do projeto:** cada projeto pode ter um workspace padrão, e a conversa nova no projeto (na tela de conversa nova ou na caixa da mesa, no hub) já vem com ele. O card **Workspace** do hub mostra o padrão (com o time e quantas regras, comandos e arquivos ele tem) e abre a página dele; os outros workspaces que têm o projeto aparecem embaixo, com **Tornar padrão**, e o `⋯` cria um novo ou deixa o projeto sem padrão. Projeto sem nenhum workspace ganha o botão **Criar workspace**, que cria um com o nome dele, já como padrão. Um workspace novo vira o padrão do projeto principal dele quando esse projeto ainda não tem um.
  - **Na conversa:** a caixa de mensagem tem o workspace ao lado do time: **Sem workspace** ou qualquer workspace que tenha o projeto (como principal ou não), com o padrão marcado, e atalhos para editar o escolhido ou torná-lo o padrão do projeto. Na conversa nova, escolher um workspace traz o time padrão dele, até você mexer no time; trocar de projeto mantém o workspace se ele também tem o novo, senão vai para o padrão do novo. Numa conversa que já começou, trocar funciona como trocar o time: parada no painel, ela é retomada com o contexto do workspace novo, e fechada, vale quando for aberta. No celular, o workspace no topo da conversa abre o mesmo menu. Uma conversa num worktree segue o projeto de origem.
  - Toda conversa do workspace recebe o contexto no prompt de sistema: as instruções, as regras, os comandos (para validar antes de dar algo por pronto, e passar a quem do time for testar), os outros projetos e os arquivos. Textos pequenos (até uns 30 KB no total) vão inteiros; PDFs, imagens e textos grandes vão como caminhos, que ele lê quando forem relevantes.
  - A conversa guarda só de qual workspace ela é: o contexto é montado do workspace atual toda vez que o processo dela sobe (conversa nova, reabrir, reinício, bifurcar, trocar o time). Editou o workspace, vale a partir da próxima vez que cada conversa for aberta.
  - O topo da conversa mostra o workspace na cor dele, e a placa da área na salinha também. Os workspaces ficam em `~/.local/share/editr/workspaces.json` (`WORKSPACES_FILE`), com os arquivos em `workspace-files/` ao lado; o padrão de cada projeto vai junto, em `defaultFor`. Na primeira vez com esta versão, cada projeto fica com o workspace de que ele é o principal (o editado por último, se for de mais de um).
- **Times de agentes:** subagentes seus, cada um com nome, papel, modelo, esforço e instruções, e um claudinho próprio (o mesmo em todas as conversas). Na conversa nova, o botão de pessoas ao lado do modelo escolhe um time ou abre **Gerenciar times**, onde dá para montar um do zero ou começar cada membro por um papel pronto (Frontend, Backend, Testes, Revisão). O time vira os subagentes da conversa (a opção `agents` do SDK, com o modelo e o esforço de cada membro), e o Claude dela recebe no prompt de sistema quem é quem, para delegar o que for da área de cada um.
  - **Gerenciar times** é desenhado como as habilidades: os times à esquerda e o escolhido à direita, com um membro por linha (claudinho, papel, modelo e esforço). Tocar num membro abre o editor nele, um membro aberto por vez. Apagar manda para a lixeira, com **Desfazer** ali mesmo e, no pé da lista, **Restaurar** e apagar de vez; o que passa de 30 dias lá some sozinho.
  - A conversa guarda uma cópia do time de quando começou: editar ou apagar o time só vale para as conversas novas, e reabrir, retomar depois de reiniciar ou bifurcar traz o mesmo time. O time é escolhido só ao começar: o SDK fixa os subagentes quando o processo sobe.
  - Na conversa, o chip do time na barra da caixa (no PC) mostra quem é o time e troca por outro. Cada membro chamado entra no trilho de agentes com o claudinho dele.
  - Na salinha, os membros ficam na área mesmo sem trabalho, descansando; quando são chamados, saem do lugar até a estação, com o chapéu do modelo deles, e ao terminar levam a pasta ao claudinho da conversa.
  - Só para conversas abertas no painel: as do terminal do PC não recebem subagentes de fora. Os times ficam em `~/.local/share/editr/teams.json` (`TEAMS_FILE`).
- **Mapa mental:** o botão de rede no topo troca o chat por um mapa mental da conversa, ao vivo. No centro fica a conversa; cada mensagem sua é um galho numerado, com uma cor; dele saem os passos do Claude, com o que ele disse que ia fazer (ou, se não disse nada, o raciocínio ou o que mais fez: "Lendo 3 arquivos", "Rodando 2 comandos"), as aprovações, as perguntas e a resposta. Nas pontas fica o que cada passo tocou: arquivos (lidos, criados ou editados, com +linhas −linhas), comandos, buscas, sites e subagentes, com o que eles fizeram.
  - Enquanto o Claude trabalha, o galho em andamento fica azul com a linha correndo, e o mapa acompanha sozinho o passo atual, sempre, sem botão para ligar ou desligar. Arrastar ou rolar com a mão segura o mapa onde você deixou por alguns segundos, para dar para olhar outra parte; depois disso, cada passo novo volta a ficar à vista. Com o Claude parado nada muda de foco, então nada puxa você de volta. Um pedido de aprovação ou uma pergunta fica laranja no mapa, e o cartão para responder (**Permitir**, **Negar**, as opções) aparece acima da caixa de mensagem, sem sair do mapa. Dá para mandar mensagem e parar o Claude normalmente.
  - Turnos antigos ficam recolhidos: tocar num turno abre ou fecha os passos dele, e passos com muitas ações mostram as mais recentes (**+N ações** abre o resto). Tocar num passo ou numa ação volta ao chat naquele ponto, que pisca para ser achado; num subagente, volta ao chat com a conversa dele em foco.
  - **Caminho** (o padrão a partir de meia tela): uma linha por turno, e cada nó sai do anterior, com seta — sua mensagem, os passos do Claude em ordem e a resposta. Numa decisão o caminho passa pelo losango e **segue pela opção que você escolheu**, com as descartadas penduradas embaixo; várias decisões seguidas ficam encadeadas, uma saindo da escolha da outra. As ações de cada passo (arquivos, comandos) não viram nós, ficam no resumo dele ("3 ações") — eram elas que faziam o mapa crescer tanto para baixo —, e tocar no passo leva a elas no chat. Uma linha à esquerda liga os turnos, e como cada turno é uma faixa só, nenhum fica recolhido.
  - O desenho se ajusta à tela: no celular em pé, uma árvore de cima para baixo. O botão da barra troca entre o caminho, o mapa clássico (galhos dos dois lados do centro), galhos todos para a direita e a árvore, com zoom pelos botões, pela pinça no celular ou Ctrl + roda no PC. No PC com espaço, **lado a lado** mostra o chat e o mapa juntos, e a divisória entre eles muda o tamanho de cada um: arrastar (ou as setas do teclado, com ela em foco) passa espaço de um para o outro, e dois cliques voltam ao tamanho padrão. O tamanho fica salvo e vale para todas as conversas.
  - **Pontos de decisão:** cada pergunta que o Claude fez com opções vira um losango, e cada opção um galho dele. O caminho que você tomou fica aceso, com ✓, borda cheia e a ligação forte; as opções que ficaram para trás ficam apagadas, riscadas e com a ligação tracejada — dá para ver de longe por onde a conversa foi. Múltipla escolha acende todas as marcadas; resposta escrita à mão vira um galho próprio, marcado como **sua resposta**, com as opções oferecidas descartadas; pergunta ainda aberta fica em âmbar. Turno recolhido avisa quantas decisões tem ("4 passos · 2 decisões"), e uma decisão nunca vai para o **+N ações**. Vale para perguntas feitas ao vivo no painel e para as que estão no histórico: nesse caso a resposta é recortada do texto que o Claude Code grava no resultado da pergunta, porque a versão estruturada não chega pelo SDK.
  - **Salvar como imagem** baixa o mapa como está na tela, em PNG ou SVG; no celular, **Compartilhar imagem** manda direto para outro app.
- **Em segundo plano:** quando o Claude deixa algo rodando e encerra a resposta (um **Monitor** vigiando um build, um comando com `run_in_background`, um subagente, um workflow), a conversa não aparece como concluída: o cabeçalho mostra **Em segundo plano**, e a lista de conversas, o claudinho trabalhando e a tarefa embaixo do título. No fim da conversa, o bloco **Em segundo plano**, como o das ferramentas do turno, tem uma linha por tarefa: o tipo, o que ela faz e há quanto tempo roda (os subagentes ficam no trilho de agentes, e não no bloco), e lembra que o Claude volta sozinho ao terminar (num monitor, a cada novidade). Tocar num comando ou monitor abre o comando inteiro e o que ele escreveu, atualizando sozinho, e o quadradinho ao lado **para** a tarefa (o Claude recebe o aviso). O som e a notificação de "terminou" só vêm quando não sobra nada em segundo plano, e não a cada passo de um monitor.
- Durante a resposta, a linha embaixo do chat diz o que está rodando e há quanto tempo (ex.: "Rodando Bash · npm run build · 1min 12s"), em vez de só "Trabalhando…". Ao lado, o claudinho da conversa dá pulinhos com um balão de "…" enquanto roda uma ferramenta, fica com a mão no queixo quando só pensa e, quando o turno acaba bem, faz um joinha antes de sair; com a redução de movimento do sistema ligada, ele fica parado. O mesmo claudinho, com as mesmas poses, mostra o estado na alça, nas abas e nas listas de conversas (pensando só nas do painel; as abertas no PC mostram o "…").
- Numa conversa parada, modelo, esforço e modo escolhidos na caixa valem quando ela for retomada.
- Sem internet, ou com o PC fora de alcance, a mensagem não se perde, como no WhatsApp: aparece com um relógio e **Aguardando conexão** e é enviada sozinha, na ordem, assim que a conexão volta, mesmo que o app tenha sido fechado nesse meio-tempo. Se não der para entregar (por exemplo, a sessão foi aberta no PC), ela fica marcada como **Não enviada**, com **Tentar de novo** e **Descartar**. Um reenvio nunca repete o turno no Claude.
- Imagens que o Claude devolve (prints, imagens lidas) e as que você envia aparecem como miniatura, reduzida no PC (até 512 px) para pesar pouco no 4G; o original só é baixado ao ampliar. Tocar abre a imagem ampliada por cima do chat, com quem mandou e a posição no topo ("Claude · 3 / 8"):
  - deslizar de lado, ou as setas, passa pelas outras imagens do mesmo lado da conversa, na ordem do chat;
  - zoom com pinça, toque duplo, os botões − e + ou a roda do mouse; ampliada, arrastar passeia pela imagem, e tocar na porcentagem volta ao tamanho normal;
  - tocar fora da imagem fecha, e o botão de abrir leva ao arquivo original.
- O voltar do celular fecha o que está aberto por cima (menu, painel, diálogo, imagem) antes de sair da tela.

As ações do Claude aparecem num bloco separado das mensagens. No chat, o bloco vira uma linha só, que abre ao tocar: quantos passos (`5 ferramentas · 2 raciocínios`), as falhas, as linhas colocadas e tiradas, quanto levou do primeiro ao último e, na ponta, o passo rodando agora ou o último; as imagens devolvidas e os subagentes continuam à vista embaixo dela. Cada ferramenta mostra quanto levou (rodando, há quanto tempo roda), também no histórico, pela hora que o Claude Code grava no transcript. As aprovações e as perguntas com opções aparecem como cartões; respondida, a pergunta volta para a linha dela no bloco (a AskUserQuestion), que mostra o que você escolheu (`Plano → Pode seguir`) e, aberta, as perguntas com as opções e a escolhida acesa, também nas conversas abertas no PC. O botão de lista no topo abre o resumo da sessão, uma ilha como o Computador, com as seções à esquerda (pílulas no celular), cada uma com a contagem: **Geral** traz o consumo (quanto do contexto está ocupado, tokens de entrada, saída e cache, e o custo estimado em dólar por modelo, subagentes incluídos) e um bloco por assunto do que a conversa fez (arquivos, comandos, testes, erros, links, mídia), que leva à seção dele (os testes abrem os comandos já filtrados). **Arquivos**, **Comandos** e **Links** são as mesmas listas dos atalhos da resposta, com busca e filtros, só que da conversa inteira, subagentes incluídos; **Erros** junta as ferramentas que falharam, com filtro por ferramenta; **Mídia** mostra as imagens numa grade, separadas em suas e do Claude. Seção vazia some. O custo vem do registro da conversa salvo no PC, a preço de tabela da API: no plano de assinatura, o uso conta nos limites do plano e não é cobrado à parte. Para ditar, toque no microfone da caixa de mensagem: o texto aparece enquanto você fala, onde estava o cursor, e as ondas da voz aparecem na linha de baixo. No Firefox, com o Whisper instalado no PC (ver [Ditado no Firefox](#ditado-no-firefox-whisper)), o microfone grava: toque de novo para parar, e o texto aparece de uma vez alguns segundos depois ("Transcrevendo no PC…"), sem sair do PC; gravação só de silêncio nem é enviada. Pausas para pensar não desligam o microfone: o ditado termina ao tocar de novo, ao enviar, ao começar a digitar, ao sair do app ou depois de 1 minuto sem fala. É o reconhecimento de voz do navegador (no Android, o mesmo do Google que o Gboard usa), então precisa de internet e da permissão de microfone na primeira vez. Nada é enviado sozinho: revise e toque em enviar. O ditado do próprio Gboard também funciona: Enter quebra linha, e o envio é pelo botão.

No campo de mensagem, tanto no chat quanto em "Nova sessão":
- **A caixa grande** (o botão de expandir, ao lado do **+**): para prompts longos, a caixa sai do rodapé e vira uma folha centrada na tela, com área de digitação de quase metade da altura e o resto escurecido, para o texto ficar sozinho na frente. Fecha pelo mesmo botão, tocando fora, pelo Esc no PC, pelo voltar do celular, ou sozinha ao enviar. Os controles (anexo, comandos, modelo, modo, ditado) continuam todos à mão.
- **`/`** no início lista os comandos e skills do projeto: as suas skills e as de plugins primeiro, depois as internas. Comandos que só funcionam como tela no terminal (`/config`, `/mcp`, `/agents`…) ficam de fora.
- **`@`** lista os arquivos e pastas do projeto. Escolher uma pasta continua a navegação dentro dela.
- **📎** anexa arquivos. No Android, o seletor oferece câmera, galeria e arquivos.
  - **Imagens** são reduzidas no celular para até 1568 px e vão direto para o Claude. Tocar numa imagem anexada (a do lápis) abre o editor: caneta, seta, círculo e recorte, em cinco cores, com desfazer; **Pronto** troca o anexo pela versão marcada.
  - **Outros arquivos** (até 25 MB) são gravados no PC em `~/.cache/editr/uploads/<sessão>/` e entram na mensagem como `@caminho`. O Claude Code lê qualquer tipo assim, inclusive PDF.
- No PC, colar um print com Ctrl+V também anexa.
- O rascunho de cada conversa (texto e anexos) fica guardado no celular: trocar de conversa, tocar em **Atualizar** ou o Android fechar o app não perde o que foi digitado.
- No Android, o edit.r aparece no menu **Compartilhar** dos outros apps (prints, fotos, arquivos, links): escolha a conversa, ou uma nova, e tudo entra no rascunho dela para você revisar antes de enviar. Depois de atualizar, o Android pode levar até um dia para mostrar o app no menu; reinstalar o app faz aparecer na hora.

## Como funciona

- Quem conduz as conversas é um **agente**: hoje, o Claude Code. O edit.r fala com ele por um contrato próprio (ver [Agentes](#agentes)), e um agente novo entra como mais uma implementação dele, sem mexer no resto.
- Cada sessão controlada pelo celular tem um único dono: um processo headless do agente (no Claude Code, dirigido pelo Agent SDK).
- Sessões abertas no PC aparecem no celular com o campo de mensagem de sempre. Enviar daqui encerra a sessão no terminal do PC, se ela estiver ociosa, e a continua no painel com todo o contexto; não há botão de assumir, e cada mensagem mostra de onde saiu. Trabalhando no PC, a mensagem não sai e fica com **Tentar de novo**; aberta no VSCode, é preciso fechá-la lá antes (encerrar a extensão pode fazê-la retomar a conversa sozinha e bifurcá-la). **Liberar** devolve a sessão ao terminal (`claude --resume <id>`).
- O estado real das sessões do PC vem de `claude agents --json`.
- Não há conta nem senha: o servidor escuta só em `127.0.0.1`, e o acesso remoto passa pelo `tailscale serve` com a identidade do dono. Com PIN (ver [PIN](#pin)), a API e o WebSocket pedem também o token de quem acertou, no cabeçalho `Authorization: Bearer` ou em `?t=` (WebSocket, imagens e links de arquivo).

## Operação do serviço

```sh
systemctl --user status editr
systemctl --user restart editr       # após mudar o código do servidor
journalctl --user -u editr -f        # logs
editr -link                          # link de acesso remoto (atalho)
editr -link off                      # desligar o acesso remoto (`editr -link on` liga de novo)
tailscale serve status              # acesso remoto
```

Se cair, o serviço volta sozinho em ~3 s. As sessões que estavam abertas no painel aparecem como paradas e podem ser retomadas pelo ID.

## Desenvolvimento

```sh
pnpm install
pnpm build        # gera web/dist (com .br e .gz de cada arquivo), que o backend serve; basta recarregar a página
pnpm dev:web      # Vite em http://localhost:5173 com proxy para o serviço na 7337
pnpm check        # tipos do server, do web e do app do PC
pnpm desktop      # o app do PC (Electron), do repositório
pnpm desktop:dist # AppImage, .deb e .pacman em desktop/release
```

#### Publicar uma versão do app

Os commits e PRs na `main` não publicam nada: a versão sai quando você leva a `main` para a branch `release`. Cada push nela faz o workflow `.github/workflows/desktop.yml` publicar o AppImage, o `.deb`, o `.pacman` e o `latest-linux.yml` (de onde o app instalado procura a versão nova) num Release do GitHub, e o cartão **Atualização do PC** das instalações pelo git mostra as novidades (ver [Atualizar](#atualizar)). Nos PRs para a `release`, o workflow compila os pacotes sem publicar; nos PRs para a `main`, só roda o `pnpm check`. O Electron e as ferramentas do empacotamento entram antes, baixados pela API do GitHub com o token do workflow (`desktop/scripts/seed-downloads.sh`), porque os downloads anônimos dos Releases podem falhar em massa.

```sh
git fetch origin
git push origin origin/main:release   # publica o que está na main do GitHub
```

A versão sobe sozinha no patch, a partir da última tag (`v0.1.3` → `v0.1.4`), e a tag é criada no commit publicado (`desktop/scripts/version.mjs`). Para subir a minor ou a major, commite a versão nova no `desktop/package.json` (`"version": "0.2.0"`): maior que a última tag, ela vale. Se a publicação falhar, o workflow tira a tag e o Release pela metade, e o próximo push tenta a mesma versão.

O app do PC fica em `desktop/`: o processo principal do Electron (`src/main.ts`, a janela, a bandeja e o menu), quem acha ou sobe o servidor (`src/server.ts`, que roda o `server/src/index.ts` no Node do próprio Electron, com `ELECTRON_RUN_AS_NODE`), o ambiente do shell de login (`src/shell-env.ts`), os avisos do sistema (`src/notifications.ts`, que ouve `/api/push/local`), a versão nova dos Releases (`src/updates.ts`, com o `electron-updater`) e o preload que dá ao app web o `window.editr` (`web/src/lib/desktop.ts`). O `scripts/stage.mjs` junta o servidor com as dependências de produção e o app web para o `electron-builder.yml`.

O serviço lê o frontend de `web/dist` a cada requisição, então um `pnpm build` não exige reiniciar o serviço. Mudanças no backend exigem `systemctl --user restart editr`. Para rodar o backend em modo dev, pare o serviço antes (`systemctl --user stop editr` e depois `pnpm dev`) ou use outra porta (`PORT=7338 pnpm dev`).

### Agentes

O edit.r não fala direto com o Claude Code: o núcleo do servidor (`panel-session.ts`, `manager.ts`) só conhece o contrato de `server/src/providers/types.ts`, e cada agente é um *strategy* que o implementa. O Claude Code fica todo em `server/src/providers/claude/` (o Agent SDK, o que ele guarda em `~/.claude`, a memória, as skills e os MCPs); fora dessa pasta, nada importa o SDK.

O contrato separa:
- **Mensagem** (`UserTurn`): o texto, as imagens e o contexto que vai só para o agente, com o id que o edit.r escolhe.
- **Resposta**: o agente traduz o que fala para os eventos do painel (`PanelEvent`, em `events.ts`): falas, raciocínio, ferramentas e resultados, subagentes, tarefas em segundo plano, fim do turno. As ferramentas usam os nomes do Claude Code (Bash, Read, Edit, Agent…), que o app já sabe desenhar.
- **Aprovação e pergunta** (`ApprovalRequest`, `QuestionRequest`): o agente pede pelo `RunHost`, e o edit.r mostra o cartão e devolve a decisão.
- **Modelo** (`ModelOption`, `RunSettings`): os modelos, os níveis de esforço e os modos de permissão que o agente aceita.
- **Conversa salva** (`ProviderHistory`): listar, ler, renomear e apagar, e o histórico já em eventos.
- **Conversas fora do painel** (`ExternalSessions`, opcional): as abertas no terminal, para a lista, a salinha, os avisos e o "assumir".
- **O que ele oferece** (`features`): uso do plano, memória, skills, MCP, esforço, modos de permissão, bifurcação. É o que liga as abas da página dele no painel Computador e os controles do chat.

Para um agente novo: implemente `AgentProvider` numa pasta `server/src/providers/<id>/` e registre na lista de `index.ts` (`new ProviderRegistry([claude, …])`). Ele nasce desligado; quem liga é você, em **Computador → Agentes**, que guarda a escolha em `~/.local/state/editr/agents.json`. Com mais de um ligado, a conversa nova pergunta qual usar.

Estrutura do frontend (`web/src`):
- `lib/store.ts`: WebSocket com reconexão automática e retomada pelo último `seq`.
- `lib/outbox.ts`: fila das mensagens ainda não entregues, guardada no IndexedDB e enviada quando a conexão volta.
- `lib/push.ts` e `sw.ts`: inscrição nas notificações e o service worker que as mostra (e guarda o app em cache).
- `lib/api.ts`: cliente REST.
- `lib/providers.ts`: os agentes de cada máquina (ligados, padrão, o que cada um oferece), com o "só o Claude Code" para servidor de antes deles.
- `pages/`: telas (início, conversas, projetos, nova sessão, chat); o Computador é um painel, em `components/computer-sheet.tsx`.
- `components/home/`: painéis do início (saudação, pedidos, limites, grid do ano, gráficos, projetos).
- `components/office/`: a salinha em SVG (`vector/`: os claudinhos dos avatares com perninhas, os móveis e o prédio desenhados em código, quem anda para onde).
- `components/chat/`: blocos de atividade, cartões de aprovação e de pergunta, campo de mensagem e resumo.

## Cliente de teste (no lugar do celular)

```sh
cd server
node scripts/poc-client.ts list
node scripts/poc-client.ts new ~/Projects/algum-projeto "sua instrução"
node scripts/poc-client.ts watch <id>            # pede s/N nas aprovações e a opção nas perguntas
node scripts/poc-client.ts send <id> "próxima mensagem"
node scripts/poc-client.ts takeover <id>         # retomar aqui, encerrando a sessão ociosa do terminal
node scripts/poc-client.ts release <id>          # devolver ao terminal
```

## API

| Método | Rota | Uso |
|---|---|---|
| GET | `/api/pin` | `{enabled, length?, retryAfter?, unlocked}`: se há PIN e se o token enviado ainda vale (aberta mesmo com PIN) |
| POST | `/api/pin/unlock` | `{pin}` → `{token}` (`403 pin_wrong` com `attemptsLeft`, `429 pin_blocked` com `retryAfter`) |
| POST | `/api/pin/lock` | O token enviado deixa de valer, e os WebSockets abertos com ele caem (código `4401`) |
| GET | `/api/sessions` | Catálogo: salvas + vivas no PC + do painel, com `owner`, `state` e `provider` (o agente da conversa) |
| GET | `/api/agents` | Os agentes: `[{id, name, description, enabled, default, available, problem?, version?, features}]` |
| POST | `/api/agents/:id` | `{enabled?, default?}`: liga, desliga ou torna padrão das conversas novas → a lista atualizada (`409 last_agent` ao desligar o último, `409 agent_unavailable` se ele não está pronto) |
| GET | `/api/config-sync` | O repositório de configuração: `{repo, url, machine, lastPush, lastPull, remote}` (`remote`: o último envio que o clone conhece, de qualquer máquina) |
| POST | `/api/config-sync/connect` | `{repo, create?}`: liga a `dono/nome` (ou só `nome`) no GitHub, pelo `gh`, ou a um endereço git; `create` cria, privado (`409 config_repo_public`, `422 gh_auth`) |
| POST | `/api/config-sync/disconnect` | Esquece o repositório e apaga o clone (o repositório fica como está) |
| POST | `/api/config-sync/run` | `{direction: push\|pull, kinds, appearance?, dry?}`: envia ou traz as categorias; `dry` é a prévia. Devolve, por categoria, o que entrou, mudou e ficou (com o motivo), os projetos que não existem aqui, o commit e, ao trazer, a aparência de lá (`409 config_sync_busy`) |
| GET | `/api/projects` | Diretórios disponíveis para sessões novas |
| GET | `/api/sessions/:id/history` | Histórico salvo, normalizado |
| GET | `/api/sessions/:id/tasks/:taskId/output` | Fim da saída (até 8 KiB) de um comando ou monitor em segundo plano da conversa aberta no painel |
| POST | `/api/sessions/:id/tasks/:taskId/stop` | Para uma tarefa em segundo plano; o Claude recebe o aviso |
| GET | `/api/transcribe` | `{available}`: se o Whisper está instalado neste PC |
| POST | `/api/transcribe` | `{audio}` (WAV em base64, até ~10 min): transcreve em português com o Whisper (`503 whisper_unavailable`) |
| GET | `/api/speak` | `{available}`: se o Piper está instalado neste PC |
| POST | `/api/speak` | `{text}` (até 1000 caracteres): a frase falada pelo Piper, em WAV (`503 piper_unavailable`) |
| GET | `/api/sessions/:id/agents/:toolUseId` | O que o subagente criado por essa chamada da ferramenta Agent fez, do transcript salvo (`?agentId=` poupa a busca; `404 agent_not_found`) |
| POST | `/api/sessions` | Nova sessão `{provider?, cwd?, prompt, attachments?, model?, effort?, permissionMode?, worktree?}`; sem `provider`, no agente padrão; sem `cwd`, abre em `~`; com `worktree`, abre num worktree novo do projeto |
| POST | `/api/sessions/:id/open` | Retomar no painel (`409 live_on_pc` se estiver aberta no PC; `410 worktree_removed` se o worktree dela foi removido) |
| POST | `/api/sessions/:id/takeover` | Retomar no painel, encerrando antes a sessão ociosa do terminal; o app chama ao enviar numa conversa que não está aberta nele (`409 busy_on_pc` se estiver ocupada, `409 unsupported_entrypoint` se for do VSCode) |
| POST | `/api/sessions/:id/release` | Liberar para o terminal |
| POST | `/api/sessions/:id/messages` | Enviar `{text, attachments?: [{name, mediaType, data (base64), thumb?}]}` |
| GET | `/api/commands?cwd=&session=&provider=` | Comandos e skills do projeto (cache de 10 min), com as habilidades do edit.r como `editr:nome`; com `session`, os do agente dela e sem as desligadas nela; sem, os do `provider` (ou do padrão) |
| GET | `/api/saved-commands?cwd=` | Os comandos salvos do terminal: `{projectDir, project, global, trash, suggestions}` (o projeto da pasta, se ela for de um repositório) |
| POST | `/api/saved-commands` | `{id?, label, command, project, pinned}`: cria ou edita (`project`: uma pasta do projeto, ou `null` para global; `400 not_a_project` fora de um repositório) |
| POST | `/api/saved-commands/trash`, `/restore`, `/purge` | `{id}`: para a lixeira, de volta, ou apaga de vez |
| GET | `/api/habilidades?cwd=` | As habilidades do edit.r: `{global, project, trash}` (as do projeto de `cwd`, se veio) |
| POST | `/api/habilidades` | `{id?, name, description, body, project}`: cria ou edita (`project`: a pasta, ou `null` para global; `409 habilidade_exists`, `400 invalid_habilidade_name`) |
| POST | `/api/habilidades/trash`, `/restore`, `/purge` | `{id}`: para a lixeira, de volta, ou apaga de vez |
| GET | `/api/todos?cwd=` | O TODO do projeto: `{items, rev}` (`rev` sobe a cada mudança) |
| POST | `/api/todos` | `{cwd, items, rev?}`: a lista inteira como ficou; com `rev`, `409 todos_changed` se ela mudou no PC desde que o app leu |
| GET | `/api/detalhes?cwd=` | Os detalhes do projeto: `{items, rev}`, cada um com a `chave` tirada do título |
| POST | `/api/detalhes` | `{cwd, items, rev?}`: a lista inteira como ficou; com `rev`, `409 detalhes_changed` se ela mudou no PC desde que o app leu |
| GET/POST | `/api/sessions/:id/habilidades` | `{off}`: as desligadas na conversa; o POST `{id, on}` liga ou desliga uma, e a conversa aberta no painel relê na hora |
| GET | `/api/memory?cwd=` | A memória do Claude Code: `{folders, trash}`, de todos os projetos ou, com `cwd`, de um |
| PUT | `/api/memory` | `{folder, file, description, body, mtime}`: grava uma memória (`409 memory_changed` se o arquivo mudou desde `mtime`) |
| POST | `/api/memory/trash` | `{items: [{folder, file}]}` → `{ids}`: para a lixeira do edit.r, tirando a linha do índice |
| POST | `/api/memory/restore` | `{ids}`: devolve da lixeira, com a linha do índice no lugar (`409 memory_exists`) |
| POST | `/api/memory/trash/empty` | `{ids?}`: apaga de vez as escolhidas ou, sem `ids`, a lixeira inteira |
| GET | `/api/claude/setup?cwd=&refresh=1` | Skills, comandos, agentes e servidores MCP da pasta (sem `cwd`, da pessoal), com a origem de cada um e onde mais há MCPs; cache de 10 min |
| GET | `/api/claude/text?cwd=&path=` | O texto de uma skill, comando ou agente que vale na pasta |
| POST | `/api/claude/mcp` | `{cwd?, name, enabled}`: liga ou desliga um servidor MCP na pasta (sem `cwd`, na pessoal) |
| POST | `/api/claude/skill` | `{cwd?, name, enabled}`: liga ou desliga uma skill pelo `skillOverrides` (sem `cwd`, em todo projeto; com, só nele) |
| POST | `/api/claude/plugin` | `{key, enabled}`: liga ou desliga um plugin (`nome@marketplace`) pelo `claude plugin` |
| POST | `/api/claude/trash` | `{cwd?, path}` (skill, comando ou agente seu ou do projeto) ou `{mcp: {name, scope, project?}}` → `{id}`: para a lixeira do edit.r |
| POST | `/api/claude/restore` | `{ids}`: devolve da lixeira (`409 claude_exists` se o lugar estiver ocupado) |
| POST | `/api/claude/trash/empty` | `{ids?}`: apaga de vez as escolhidas ou a lixeira inteira |
| POST | `/api/sessions/:id/pin` | `{pinned}`: fixa ou desafixa (guardado em `~/.local/state/editr/meta.json`) |
| POST | `/api/sessions/:id/rename` | `{title}`: grava no próprio agente (no Claude Code, `renameSession` do SDK) |
| POST | `/api/sessions/:id/settings` | `{model?, effort?, permissionMode?}` numa sessão aberta no painel |
| GET | `/api/sessions/:id/context` | Tokens usados e limite da compactação automática |
| GET | `/api/models?provider=` | Modelos e níveis de esforço do agente (sem `provider`, do padrão; cache de 10 min) |
| POST | `/api/sessions/:id/delete` | Apaga a conversa no agente (no Claude Code, `deleteSession` do SDK), os anexos e o "fixado" |
| GET | `/api/tree?cwd=&path=` | Um nível da árvore do projeto (só leitura; nada fora do projeto) |
| GET | `/api/file?cwd=&path=` | Conteúdo para leitura: texto até 1 MB (com o `hash` do que foi lido), ou tipo (imagem, PDF, binário) |
| GET | `/api/search?cwd=&q=&regex=&case=&word=` | Busca texto nos arquivos com o ripgrep (`1` liga cada opção): `{files: [{path, matches: [{line, text, ranges, col, len}]}], total, truncated}`, até 2 mil achados; `400 invalid_search` (regex inválida), `501 rg_unavailable` |
| POST | `/api/file/save` | `{cwd, path, content, base, force?}`: grava o texto do editor por cima de um arquivo que já existe, se ele ainda é o de `base` (o `hash` lido); senão `409 file_changed` (com o `hash` de agora), a não ser com `force`. Devolve `{hash, size}` |
| GET | `/api/file/raw?cwd=&path=` | Arquivo original (imagens, PDF), com CSP que bloqueia scripts |
| POST | `/api/prototype/open` | `{path, cwd?}` (um `.html`, ou uma pasta com `index.html`; relativo, a partir de `cwd`) → `{id, entry, name, mtime}`: prepara a página para abrir (`400 not_html`, `403 path_not_allowed`, `404 prototype_not_found`) |
| GET | `/api/prototype/:id` | `{mtime}`: a mudança mais recente da página e dos arquivos ao lado dela (`404 prototype_not_found` se o id expirou) |
| GET | `/api/prototype/view/:id/*` | A página e o que ela carrega, com a CSP `sandbox` (origem opaca) e sem o PIN: o id é a credencial |
| GET | `/api/artefatos` | `{artefatos, lixeira}`: os artefatos (o mais recente primeiro), cada um com `versions`, `link` (o caminho do link fixo) e `public` (`{url, since, n}` ou `null`) |
| GET | `/api/artefatos/:id` | Um artefato (`404 artefato_not_found`) |
| POST | `/api/artefatos/:id/public` | `{on}`: liga ou desliga o link público; ligar de novo um público passa a mostrar a versão mais nova, com o mesmo link (`409 funnel_unavailable` com `detail`) |
| POST | `/api/artefatos/:id/delete` | Para a lixeira (o link público é revogado) |
| POST | `/api/artefatos/:id/restore` | Volta da lixeira, sem o link público |
| POST | `/api/artefatos/:id/purge` | Apaga de vez da lixeira, com as versões |
| GET | `/api/artefato/view/:id/:n/*` | A versão `n` e o que ela carrega, com a CSP `sandbox` e sem o PIN (o id é a credencial); guardada de vez no navegador, porque não muda |
| GET | `/a/:id/` e `/a/:id/v/:n/` | O link fixo: a casca do artefato (sem script), com a versão mais nova ou a `n` |
| GET | `/api/project-icon?cwd=` | A marca do projeto (a escolhida no app ou a achada no repositório), em WebP de 128 px, com ETag (`404 no_icon` sem uma) |
| GET | `/api/project-icon/info?cwd=` | De onde vem a marca: `{source: 'custom' \| 'repo' \| null, repo}` |
| POST | `/api/project-icon` | `{cwd, data}`: guarda a logo escolhida (imagem em base64) (`400 invalid_image`) |
| POST | `/api/project-icon/remove` | `{cwd}`: tira a logo escolhida; volta a da do repositório, se houver |
| GET | `/api/git?cwd=` | Branch, upstream, página do repositório (`remote`) e arquivos alterados com +/-, somados e de cada lado (`staged`, `unstaged`) (`null` sem git) |
| GET | `/api/git/base?cwd=&path=` | `{content}`: o arquivo no último commit, para as marcas do editor; `''` se é novo, `null` fora do git (ou ignorado) |
| GET | `/api/git/diff?cwd=&path=&side=` | Diff do arquivo contra o último commit; com `side` (`staged` ou `unstaged`), só aquele lado; novo = contra vazio |
| POST | `/api/git/stage` | `{cwd, paths}`: prepara os arquivos (apagados também) |
| POST | `/api/git/unstage` | `{cwd, paths}`: tira do stage sem mexer no arquivo |
| POST | `/api/git/commit` | `{cwd, message, all?}`: commit do que está preparado; `all` prepara tudo antes. Devolve `{sha}` |
| POST | `/api/git/sync` | `pull --ff-only` e `push`; sem upstream, publica a branch no `origin`. O que o git disser ao recusar volta em `message` |
| GET | `/api/worktree?cwd=` | Worktree de uma conversa: `branch`, `base` (para onde o "Trazer" leva), `current` (a branch do projeto agora), `ahead`, `behind` e `changed` (`410 worktree_removed`) |
| GET | `/api/worktrees` | Os worktrees de todos os projetos, por repositório (`[{root, worktrees}]`, só os que têm algum; fora o checkout principal), com o status de cada um (`unmerged`: commits que a base não tem nem rebaseados), `managed`, `missing` e `usable` |
| POST | `/api/worktrees/remove` | `{cwd, path, force?}`: apaga um worktree da lista (`404 worktree_not_found` fora dela; `409 worktree_unsaved` sem `force`) |
| POST | `/api/worktrees/merge` | `{cwd, path}`: o "Trazer" de um worktree da lista |
| POST | `/api/worktree/merge` | `{cwd}`: merge da branch do worktree na de origem, no checkout principal. Devolve `{commits}`; `409 worktree_dirty`, `nothing_to_merge`, `base_not_checked_out` ou `merge_conflict` (com `files`, e o merge desfeito) |
| POST | `/api/worktree/remove` | `{cwd, force?}`: fecha as conversas do painel que estão nele e remove o worktree (e a branch, se foi o edit.r que criou); sem `force`, `409 worktree_unsaved` se algo não voltou |
| GET | `/api/sessions/:id/images/:key` | Imagem do chat (cache em memória, refeito a partir do histórico); `?thumb=1` devolve a miniatura em WebP, até 512 px |
| GET | `/api/files?cwd=&q=` | Busca de arquivos do projeto para a menção `@` |
| POST | `/api/sessions/:id/interrupt` | Interromper o turno |
| POST | `/api/sessions/:id/approvals/:requestId` | Aprovar ou negar ferramenta: `{allow, message?, always?}` |
| POST | `/api/sessions/:id/questions/:requestId` | Responder pergunta do Claude: `{answers: {"<pergunta>": "<opção>"}}` ou `{decline: true}` |
| GET | `/api/sessions/:id/memory-suggestions` | As memórias que o Claude quis guardar na conversa e esperam você |
| POST | `/api/sessions/:id/memory-suggestions/:suggestion/save` | Salva a sugestão, com `{description?, body?}` editados (`409 memory_changed` ou `memory_exists` se o arquivo mudou ou apareceu desde ela) |
| POST | `/api/sessions/:id/memory-suggestions/:suggestion/dismiss` | Recusa a sugestão (fica uma hora para o desfazer) |
| POST | `/api/sessions/:id/memory-suggestions/:suggestion/restore` | Desfaz a recusa |
| GET | `/api/push/key` | Chave pública VAPID do PC, para o celular se inscrever |
| POST | `/api/push/subscribe` | `{subscription, prefs: {done, pc}}`: inscreve o aparelho ou muda as preferências (guardado em `~/.local/state/editr/push.json`) |
| POST | `/api/push/unsubscribe` | `{endpoint}`: remove o aparelho |
| POST | `/api/push/test` | `{endpoint}`: manda um aviso de teste a esse aparelho |
| POST | `/api/push/relay` | `{payload, opts}`: aviso repassado por outra máquina sua, entregue aos aparelhos inscritos aqui (não repassa de novo) |
| GET | `/api/machines` | Nome desta máquina e as outras suas com o edit.r (`{name, machines: [{id, name, base}]}`) |
| GET | `/api/update` | Branch e commit do PC, novidades da `release` do GitHub, bloqueios e o andamento de uma atualização |
| POST | `/api/update` | Atualiza: troca para a `release`, avança, `pnpm install`, compila o web (sem o `tsc`, já feito no PR) e reinicia (`409` com mudança local, `release` divergente, conversa trabalhando ou já em dia) |
| POST | `/api/update/restart` | Reinício que ficou adiado porque uma conversa começou a trabalhar durante a compilação |
| WS | `/ws` | `subscribe {sessionId, sinceSeq}` → `snapshot`, `event`, `delta`, `catalog`; e, para todos, `changed {what, cwd?, rev?}` quando o TODO de um projeto, os times, os workspaces ou as habilidades mudam |
| WS | `/ws/file?cwd=&path=` | O arquivo aberto no editor: `{hash}` ao ligar e a cada vez que ele muda no disco (`null` se sumiu) |
| WS | `/ws/terminal?cwd=&id=&since=` | Terminal do painel: liga no shell da aba `id` (ou abre um em `cwd`) e manda a saída a partir do byte `since`; `{t:'in'}`, `{t:'size'}`, `{t:'close'}` → `{t:'attach', fresh, from, replay}`, saída binária, `{t:'exit'}` |
