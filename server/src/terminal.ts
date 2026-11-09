import { spawn, type ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';

const BRIDGE = fileURLToPath(new URL('./terminal-pty.py', import.meta.url));
// O prompt e os blocos do painel no zsh (ver shell/editr.zsh).
const SHELL_DIR = fileURLToPath(new URL('./shell', import.meta.url));

/** Quanto da saída fica guardado para quem reanexa: recarregar a página, travar e destravar, a rede voltar. */
const KEEP_BYTES = 1 << 20;
/** Sem ninguém olhando por tanto tempo (o app fechado num aparelho que não volta), o shell acaba. */
const DETACHED_TTL = 24 * 60 * 60_000;
const MAX_TERMINALS = 32;

/** O que o painel manda: o que você digita, o tamanho do terminal na tela, ou fechar a aba (encerra o shell). */
type ClientMsg = { t: 'in'; d: string } | { t: 'size'; c: number; r: number } | { t: 'close' };

const terminals = new Map<string, Pty>();

/**
 * Um terminal do painel: o shell do usuário na pasta do projeto, num pseudo-terminal aberto pela ponte
 * em Python (terminal-pty.py). Vive no PC independente da conexão: o painel se liga pelo id da aba e,
 * caindo (o app travou, a página recarregou, a rede piscou), volta pelo mesmo id e recebe o que perdeu.
 * Só acaba quando o shell sai, quando a aba é fechada, ou depois de um dia sem ninguém ligado.
 */
class Pty {
  private readonly sockets = new Set<WebSocket>();
  private readonly child: ChildProcess;
  private readonly control: Writable;
  // A saída recente, em pedaços, e quantos bytes já saíram ao todo: quem reanexa diz até onde viu.
  private chunks: Buffer[] = [];
  private kept = 0;
  private total = 0;
  private orphan: NodeJS.Timeout | undefined;
  private gone = false;

  readonly id: string;
  /** Aberto sem id (um app de antes das abas): acaba ao fechar a conexão, como era. */
  private readonly ephemeral: boolean;

  constructor(id: string, cwd: string, ephemeral: boolean) {
    this.id = id;
    this.ephemeral = ephemeral;
    this.child = spawn('python3', [BRIDGE], {
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', EDITR_SHELL_DIR: SHELL_DIR },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    this.control = this.child.stdio[3] as Writable;
    // Escrever depois de o shell sair dá EPIPE nas pipes: sem quem ouça, derrubaria o servidor.
    this.child.stdin!.on('error', () => {});
    this.control.on('error', () => {});
    this.child.stdout!.on('data', (chunk: Buffer) => this.output(chunk));
    // Erros da própria ponte (não do shell, que escreve no pty): aparecem no terminal, em vermelho.
    this.child.stderr!.on('data', (chunk: Buffer) => this.output(Buffer.concat([Buffer.from('\x1b[31m'), chunk, Buffer.from('\x1b[0m')])));
    this.child.on('error', (err) => this.end({ t: 'exit', error: err.message }));
    this.child.on('exit', (code) => this.end({ t: 'exit', code }));
  }

  private get start(): number {
    return this.total - this.kept;
  }

  private output(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.kept += chunk.length;
    this.total += chunk.length;
    while (this.kept > KEEP_BYTES && this.chunks.length > 1) this.kept -= this.chunks.shift()!.length;
    for (const socket of this.sockets) if (socket.readyState === socket.OPEN) socket.send(chunk);
  }

  /**
   * Liga uma conexão: conta se o shell é novo e de que byte vem o que segue. Quem já viu até `since`
   * recebe só o resto; quem pede algo que não está mais guardado (ou uma tela nova) recebe tudo o que
   * ficou, e o programa em primeiro plano se redesenha por cima.
   */
  attach(socket: WebSocket, since: number, fresh: boolean): void {
    clearTimeout(this.orphan);
    this.sockets.add(socket);
    const from = since >= this.start && since <= this.total ? since : this.start;
    socket.send(JSON.stringify({ t: 'attach', fresh, from, replay: this.total - from }));
    if (from < this.total) socket.send(Buffer.concat(this.chunks).subarray(from - this.start));
    if (!fresh && from !== since) this.control.write('w\n');

    socket.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw)) as ClientMsg;
      } catch {
        return;
      }
      if (msg.t === 'in' && typeof msg.d === 'string') this.child.stdin!.write(msg.d);
      else if (msg.t === 'size' && Number.isInteger(msg.c) && Number.isInteger(msg.r)) this.control.write(`${msg.c} ${msg.r}\n`);
      else if (msg.t === 'close') this.kill();
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (this.sockets.size || this.gone) return;
      if (this.ephemeral) this.kill();
      else this.orphan = setTimeout(() => this.kill(), DETACHED_TTL).unref();
    });
  }

  /** Fim da entrada: a ponte encerra o shell (SIGHUP), como fechar a janela do terminal. */
  kill(): void {
    clearTimeout(this.orphan);
    this.child.stdin!.end();
    setTimeout(() => this.child.kill(), 2000).unref();
  }

  private end(msg: { t: 'exit'; code?: number | null; error?: string }): void {
    if (this.gone) return;
    this.gone = true;
    clearTimeout(this.orphan);
    if (terminals.get(this.id) === this) terminals.delete(this.id);
    const data = JSON.stringify(msg);
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(data);
      socket.close();
    }
  }
}

const validId = (id: string | undefined): id is string => typeof id === 'string' && /^[\w-]{8,64}$/.test(id);

/** Volta a um terminal que ainda vive no PC; `false` se não há (a pasta é conferida antes de abrir um novo). */
export function attachTerminal(socket: WebSocket, id: string | undefined, since: number): boolean {
  const pty = validId(id) ? terminals.get(id) : undefined;
  if (!pty) return false;
  pty.attach(socket, Number.isSafeInteger(since) && since >= 0 ? since : 0, false);
  return true;
}

/** Abre um shell na pasta (já conferida) e liga a conexão nele. Sem id, vale só enquanto ela durar. */
export function openTerminal(socket: WebSocket, cwd: string, id: string | undefined, since: number): void {
  // Duas conexões com o mesmo id novo ao mesmo tempo: a segunda chega com o shell já aberto pela primeira.
  if (attachTerminal(socket, id, since)) return;
  if (terminals.size >= MAX_TERMINALS) {
    socket.send(JSON.stringify({ t: 'exit', error: `já há ${MAX_TERMINALS} terminais abertos no PC; feche algum` }));
    socket.close();
    return;
  }
  const ephemeral = !validId(id);
  const pty = new Pty(ephemeral ? crypto.randomUUID() : id, cwd, ephemeral);
  terminals.set(pty.id, pty);
  pty.attach(socket, 0, true);
}
