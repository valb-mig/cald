/**
 * Os tokens do PIN (ver server/src/pin.ts), um por máquina, pelo endereço dela (`''` = a desta página).
 * Ficam na sessionStorage: recarregar a página segue destravado, fechar o app trava. A tela de
 * bloqueio e o travamento sozinho ficam em lock.ts; aqui só o que as chamadas precisam para ir com o token.
 */

const KEY = 'cald:pin-tokens'

function load(): Record<string, string> {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as unknown
    return saved && typeof saved === 'object' ? (saved as Record<string, string>) : {}
  } catch {
    return {}
  }
}

let tokens = load()

function save(): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(tokens))
  } catch {
    // sessionStorage indisponível: segue só em memória.
  }
}

/** A máquina de um endereço da API: `''` para a desta página, senão a origem dela (como em `Machine.base`). */
export function baseOfUrl(url: string): string {
  const origin = new URL(url, location.href).origin.replace(/^ws/, 'http')
  return origin === location.origin ? '' : origin
}

export const tokenAt = (base: string): string | undefined => tokens[base]

export function setToken(base: string, token: string | undefined): void {
  const { [base]: _, ...rest } = tokens
  tokens = token ? { ...rest, [base]: token } : rest
  save()
}

export function clearTokens(): Record<string, string> {
  const old = tokens
  tokens = {}
  save()
  return old
}

/** O cabeçalho para um `fetch` na API. */
export function authHeader(url: string): Record<string, string> {
  const token = tokens[baseOfUrl(url)]
  return token ? { authorization: `Bearer ${token}` } : {}
}

/** O endereço com o token em `?t=`, para o que não manda cabeçalho: WebSocket, `<img>`, links de arquivo. */
export function withToken(url: string): string {
  const token = tokens[baseOfUrl(url)]
  return token ? `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}` : url
}
