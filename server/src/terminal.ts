import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';

const BRIDGE = fileURLToPath(new URL('./terminal-pty.py', import.meta.url));
// O prompt e os blocos do painel no zsh (ver shell/claude-remote.zsh).
const SHELL_DIR = fileURLToPath(new URL('./shell', import.meta.url));

/** O que o painel manda: o que você digita, ou o tamanho do terminal na tela. */
type ClientMsg = { t: 'in'; d: string } | { t: 'size'; c: number; r: number };

/**
 * Um terminal do painel: o shell do usuário na pasta do projeto, num pseudo-terminal aberto pela ponte
 * em Python (terminal-pty.py). A saída vai crua (binária) para o xterm.js do app; o fim do shell vai
 * como `{"t":"exit"}`. Fechar o WebSocket encerra o shell.
 */
export function openTerminal(socket: WebSocket, cwd: string): void {
  const child = spawn('python3', [BRIDGE], {
    cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', CR_SHELL_DIR: SHELL_DIR },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  const control = child.stdio[3] as Writable;

  child.stdout.on('data', (chunk: Buffer) => {
    if (socket.readyState === socket.OPEN) socket.send(chunk);
  });
  // Erros da própria ponte (não do shell, que escreve no pty): aparecem no terminal, em vermelho.
  child.stderr.on('data', (chunk: Buffer) => {
    if (socket.readyState === socket.OPEN) socket.send(Buffer.concat([Buffer.from('\x1b[31m'), chunk, Buffer.from('\x1b[0m')]));
  });
  child.on('error', (err) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ t: 'exit', error: err.message }));
    socket.close();
  });
  child.on('exit', (code) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ t: 'exit', code }));
    socket.close();
  });

  socket.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      return;
    }
    if (msg.t === 'in' && typeof msg.d === 'string') child.stdin.write(msg.d);
    else if (msg.t === 'size' && Number.isInteger(msg.c) && Number.isInteger(msg.r)) control.write(`${msg.c} ${msg.r}\n`);
  });
  socket.on('close', () => {
    // Fim da entrada: a ponte encerra o shell (SIGHUP), como fechar a janela do terminal.
    child.stdin.end();
    setTimeout(() => child.kill(), 2000).unref();
  });
}
