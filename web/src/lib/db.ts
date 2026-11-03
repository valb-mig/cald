/**
 * Banco do app no aparelho (IndexedDB, porque anexos passam de dezenas de MB): a fila de mensagens
 * (`outbox`) e valores soltos (`kv`: rascunhos e o que chegou pelo "Compartilhar" do Android).
 * Usado também pelo service worker.
 */
type Store = 'outbox' | 'kv'

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    // Nome de antes da troca para cald: mudar perderia os rascunhos e a fila guardados no aparelho.
    const req = indexedDB.open('claude-remote', 2)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv')
    }
    req.onsuccess = () => {
      // Versão mais nova do banco aberta em outro lugar (app atualizado, service worker): solta esta.
      req.result.onversionchange = () => {
        req.result.close()
        opening = null
      }
      resolve(req.result)
    }
    req.onerror = () => {
      opening = null
      reject(req.error)
    }
  })
  return opening
}

export async function idb<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const s = (await open()).transaction(store, mode).objectStore(store)
  return new Promise((resolve, reject) => {
    const req = fn(s)
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error)
  })
}

export const kvGet = <T>(key: string) => idb<T | undefined>('kv', 'readonly', (s) => s.get(key))
export const kvSet = (key: string, value: unknown) => idb<IDBValidKey>('kv', 'readwrite', (s) => s.put(value, key))
export const kvDel = (key: string) => idb<undefined>('kv', 'readwrite', (s) => s.delete(key))
