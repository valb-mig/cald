// Gera .br e .gz ao lado dos arquivos de texto do build, para o servidor mandar já comprimidos
// (`preCompressed` em server/src/index.ts). Roda depois do `vite build`; sem dependências.
// Uso: node scripts/compress.mjs [pasta]   (padrão: web/dist)
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

// O zlib assíncrono comprime na thread pool do libuv, de 4 threads por padrão; com uma por núcleo o brotli
// no máximo termina antes. Vale só se definido antes do primeiro uso da pool (o readdir abaixo).
process.env.UV_THREADPOOL_SIZE ??= String(availableParallelism())

const dist = process.argv[2] ?? fileURLToPath(new URL('../dist', import.meta.url))
const TEXT = /\.(js|css|html|svg|webmanifest|json)$/
// Abaixo disso o ganho não paga o cabeçalho e a ida ao disco.
const MIN_BYTES = 1024

const brotli = promisify(brotliCompress)
const gz = promisify(gzip)

let count = 0
let raw = 0
let packed = 0

const names = (await readdir(dist, { recursive: true })).filter((name) => TEXT.test(name))
await Promise.all(
  names.map(async (name) => {
    const path = join(dist, name)
    const data = await readFile(path)
    if (data.length < MIN_BYTES) return
    const [br, gzipped] = await Promise.all([
      brotli(data, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        },
      }),
      gz(data, { level: constants.Z_BEST_COMPRESSION }),
    ])
    // Só fica a versão que é de fato menor; sem ela, o servidor manda o original.
    if (br.length < data.length) await writeFile(`${path}.br`, br)
    if (gzipped.length < data.length) await writeFile(`${path}.gz`, gzipped)
    count++
    raw += data.length
    packed += Math.min(br.length, data.length)
  }),
)

const kb = (n) => `${Math.round(n / 1024)} KB`
console.log(`compress: ${count} arquivos, ${kb(raw)} → ${kb(packed)} em brotli`)
