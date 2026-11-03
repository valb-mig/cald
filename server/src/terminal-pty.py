#!/usr/bin/env python3
"""
Ponte do terminal do painel (ver terminal.ts): abre o shell do usuário num pseudo-terminal e liga ao
servidor pelas pipes. Com o pty do próprio Python, o servidor não precisa de módulo nativo (node-pty).

  fd 0  o que você digita            → shell
  fd 1  o que o shell escreve        → painel
  fd 3  tamanho da janela, "colunas linhas\\n" por linha; "w\\n" pede para redesenhar

Acaba quando o shell sai ou quando o servidor fecha o fd 0 (o painel fechou o terminal).
"""
import errno
import fcntl
import os
import pty
import pwd
import select
import signal
import struct
import termios

# O serviço do systemd costuma vir sem $SHELL: aí vale o shell de login do usuário (o do /etc/passwd).
shell = os.environ.get("SHELL") or pwd.getpwuid(os.getuid()).pw_shell or "/bin/bash"
# A cara do painel (ver shell/cald.zsh): no zsh, os arquivos de início passam a ser os de lá,
# que carregam os do usuário e põem o prompt do painel por cima. Outros shells abrem como são.
integration = os.environ.get("CALD_SHELL_DIR")
pid, master = pty.fork()
if pid == 0:
    if integration and os.path.basename(shell) == "zsh":
        os.environ["CALD_USER_ZDOTDIR"] = os.environ.get("ZDOTDIR") or os.path.expanduser("~")
        os.environ["ZDOTDIR"] = os.path.join(integration, "zsh")
    # Shell de login: o mesmo ambiente de um terminal aberto no PC.
    os.execvp(shell, [shell, "-l"])


def write_all(fd: int, data: bytes) -> None:
    while data:
        data = data[os.write(fd, data):]


def resize(cols: int, rows: int) -> None:
    # Mudar o tamanho do pty avisa o programa em primeiro plano (SIGWINCH), como redimensionar a janela.
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def redraw() -> None:
    # Quem reanexou começou de uma tela limpa: o programa em primeiro plano (o vim, o claude) se
    # redesenha inteiro, como ao redimensionar a janela.
    try:
        os.killpg(os.tcgetpgrp(master), signal.SIGWINCH)
    except OSError:
        pass


CONTROL = 3
reading = [0, master, CONTROL]
pending = b""
while True:
    ready, _, _ = select.select(reading, [], [])
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError as e:
            if e.errno != errno.EIO:
                raise
            data = b""  # o shell saiu
        if not data:
            break
        write_all(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            break
        write_all(master, data)
    if CONTROL in ready:
        data = os.read(CONTROL, 1024)
        if not data:
            reading.remove(CONTROL)
            continue
        pending += data
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            if line == b"w":
                redraw()
                continue
            try:
                cols, rows = (int(n) for n in line.split())
                if 0 < cols < 1000 and 0 < rows < 1000:
                    resize(cols, rows)
            except ValueError:
                pass

try:
    os.kill(pid, signal.SIGHUP)
except ProcessLookupError:
    pass
os.waitpid(pid, 0)
