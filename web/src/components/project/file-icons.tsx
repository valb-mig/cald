import {
  Binary,
  Blocks,
  BookOpen,
  Braces,
  Clapperboard,
  Code,
  CodeXml,
  Container,
  Database,
  EyeOff,
  File,
  FileArchive,
  FileCog,
  FileKey,
  FileLock,
  FileText,
  FileType,
  FlaskConical,
  GitBranch,
  Globe,
  Hammer,
  Hash,
  History,
  Image,
  KeyRound,
  Languages,
  LayoutTemplate,
  Lightbulb,
  Monitor,
  Music,
  NotebookPen,
  Package,
  Palette,
  Play,
  Presentation,
  Rocket,
  Scale,
  Server,
  Settings,
  Smartphone,
  Sheet,
  Terminal,
  Type,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useId } from 'react'
import { cn } from '@/lib/utils'

/*
 * Os ícones de arquivo e pasta do edit.r. Cinza é o que não tem nada a dizer (o arquivo qualquer, a
 * trava, a fonte); o resto ganha um selo: o squircle do ícone do app, com um fundo leve na cor do tipo
 * e, dentro, a sigla da linguagem ou um glifo. As pastas conhecidas levam um glifo pequeno no canto,
 * recortado do contorno, como no JetBrains. Glifos do lucide, para conversar com o resto do app.
 */

const TONE = {
  blue: 'text-blue-600 dark:text-blue-400',
  sky: 'text-sky-600 dark:text-sky-400',
  cyan: 'text-cyan-600 dark:text-cyan-400',
  teal: 'text-teal-600 dark:text-teal-400',
  green: 'text-emerald-600 dark:text-emerald-400',
  yellow: 'text-amber-500 dark:text-amber-300',
  orange: 'text-orange-600 dark:text-orange-400',
  red: 'text-red-600 dark:text-red-400',
  rose: 'text-rose-600 dark:text-rose-400',
  pink: 'text-pink-600 dark:text-pink-400',
  purple: 'text-violet-600 dark:text-violet-400',
  indigo: 'text-indigo-600 dark:text-indigo-400',
  // O laranja do Claude: o que é dele (CLAUDE.md, a pasta .claude).
  claude: 'text-[#d97757]',
} as const

type Tone = keyof typeof TONE

/** Como um arquivo aparece: sigla no selo, glifo no selo, uma marca desenhada no selo ou a folha cinza. */
type Look =
  | { kind: 'letters'; text: string; tone: Tone }
  | { kind: 'glyph'; icon: LucideIcon; tone: Tone }
  | { kind: 'mark'; mark: keyof typeof MARKS; tone: Tone }
  | { kind: 'plain'; icon: LucideIcon }

const letters = (text: string, tone: Tone): Look => ({ kind: 'letters', text, tone })
const glyph = (icon: LucideIcon, tone: Tone): Look => ({ kind: 'glyph', icon, tone })
const mark = (m: keyof typeof MARKS, tone: Tone): Look => ({ kind: 'mark', mark: m, tone })
const plain = (icon: LucideIcon): Look => ({ kind: 'plain', icon })

const many = <T,>(exts: string, look: T) => Object.fromEntries(exts.split(' ').map((e) => [e, look]))

const BY_EXT: Record<string, Look> = {
  ...many('ts mts cts', letters('TS', 'blue')),
  ...many('js mjs cjs', letters('JS', 'yellow')),
  tsx: mark('react', 'sky'),
  jsx: mark('react', 'yellow'),
  ...many('py pyi pyw', letters('Py', 'sky')),
  go: letters('Go', 'cyan'),
  rs: letters('Rs', 'orange'),
  java: letters('Ja', 'red'),
  ...many('kt kts', letters('Kt', 'purple')),
  swift: letters('Sw', 'rose'),
  c: letters('C', 'indigo'),
  ...many('cc cpp cxx c++ ixx ccm cppm cxxm', letters('C++', 'indigo')),
  ...many('h hh hpp hxx', letters('H', 'purple')),
  ...many('m mm', letters('M', 'indigo')),
  ...many('cs csx csproj sln', letters('C#', 'purple')),
  ...many('cu cuh', letters('CU', 'green')),
  ...many('fs fsx', letters('F#', 'sky')),
  php: letters('php', 'indigo'),
  ...many('rb rake gemspec', letters('Rb', 'red')),
  dart: letters('Dt', 'teal'),
  lua: letters('Lua', 'blue'),
  ...many('ex exs', letters('Ex', 'purple')),
  ...many('erl hrl', letters('Er', 'red')),
  hs: letters('Hs', 'purple'),
  ...many('scala sc', letters('Sc', 'red')),
  ...many('clj cljs cljc edn', letters('Cl', 'green')),
  ...many('ml mli', letters('ML', 'orange')),
  zig: letters('Zg', 'yellow'),
  nim: letters('Ni', 'yellow'),
  r: letters('R', 'blue'),
  jl: letters('Jl', 'purple'),
  elm: letters('Elm', 'sky'),
  gleam: letters('Gl', 'pink'),
  sol: letters('Sol', 'indigo'),
  vue: letters('V', 'green'),
  svelte: letters('Sv', 'orange'),
  astro: letters('As', 'purple'),
  ...many('tf tfvars hcl', letters('Tf', 'purple')),
  ...many('graphql gql', letters('GQ', 'pink')),
  proto: letters('Pb', 'blue'),
  wasm: letters('Wa', 'indigo'),
  ...many('yaml yml', letters('Y', 'rose')),

  ...many('json json5 jsonc', glyph(Braces, 'yellow')),
  ...many('html htm xhtml', glyph(Code, 'orange')),
  ...many('xml xsd xsl xslt plist', glyph(CodeXml, 'orange')),
  css: glyph(Hash, 'blue'),
  ...many('scss sass', glyph(Hash, 'pink')),
  less: glyph(Hash, 'indigo'),
  ...many('md markdown mdx', mark('markdown', 'sky')),
  ...many('sh bash zsh fish ksh ps1 psm1 bat cmd', glyph(Terminal, 'green')),
  sql: glyph(Database, 'indigo'),
  ...many('png jpg jpeg gif webp bmp ico avif tif tiff heic svg', glyph(Image, 'teal')),
  ...many('mp4 mov webm mkv avi m4v', glyph(Clapperboard, 'pink')),
  ...many('mp3 wav ogg oga flac m4a aac opus', glyph(Music, 'pink')),
  ...many('csv tsv xls xlsx ods', glyph(Sheet, 'green')),
  pdf: glyph(FileText, 'red'),
  ...many('doc docx odt rtf', glyph(FileText, 'blue')),
  ...many('ppt pptx odp', glyph(Presentation, 'orange')),
  ipynb: glyph(NotebookPen, 'orange'),
  ...many('http rest', glyph(Globe, 'teal')),
  ...many('j2 jinja jinja2 hbs ejs erb twig liquid njk gohtml gotmpl tmpl razor cshtml heex leex eex slim pug', glyph(Code, 'yellow')),

  ...many('txt text rst log', plain(FileText)),
  ...many('toml ini cfg cnf conf config properties', plain(FileCog)),
  ...many('lock lockb', plain(FileLock)),
  ...many('ttf otf woff woff2 eot', plain(FileType)),
  ...many('zip tar gz tgz bz2 xz zst rar 7z jar war apk ipa deb rpm dmg iso', plain(FileArchive)),
  ...many('pem crt cer key p12 pfx gpg asc pub', plain(FileKey)),
  ...many('db sqlite sqlite3 accdb mdb dbf frm ibd ndf ora', plain(Database)),
  ...many('exe dll so dylib bin o a class pyc beam', plain(Binary)),
  cmake: plain(Hammer),
}

// Nomes inteiros, em minúsculas: valem mais que a extensão.
const BY_NAME: Record<string, Look> = {
  'claude.md': mark('claude', 'claude'),
  'claude.local.md': mark('claude', 'claude'),
  'agents.md': mark('claude', 'claude'),
  '.mcp.json': mark('claude', 'claude'),
  'package.json': glyph(Package, 'green'),
  ...many('tsconfig.json jsconfig.json', glyph(Braces, 'blue')),
  ...many('dockerfile containerfile .dockerignore', glyph(Container, 'blue')),
  ...many('docker-compose.yml docker-compose.yaml compose.yml compose.yaml', glyph(Container, 'blue')),
  ...many('.gitignore .gitattributes .gitmodules .gitkeep .git-blame-ignore-revs .mailmap', glyph(GitBranch, 'orange')),
  ...many('makefile gnumakefile justfile cmakelists.txt', plain(Hammer)),
  ...many('.editorconfig .npmrc .nvmrc .yarnrc .prettierrc .eslintrc .browserslistrc .tool-versions', plain(FileCog)),
  ...many('pnpm-lock.yaml package-lock.json yarn.lock go.sum', plain(FileLock)),
  ...many('.zshrc .bashrc .profile .bash_profile .zprofile', glyph(Terminal, 'green')),
}

/** Como o arquivo aparece, pelo nome. */
function fileLook(name: string): Look {
  const lower = name.toLowerCase()
  const known = BY_NAME[lower]
  if (known) return known
  if (/^readme(\.|$)/.test(lower)) return glyph(BookOpen, 'sky')
  if (/^(license|licence|copying)(\.|$)/.test(lower)) return plain(Scale)
  if (/^\.env(\.|$)/.test(lower) || lower.endsWith('.env')) return glyph(KeyRound, 'yellow')
  if (/^dockerfile\.|\.dockerfile$/.test(lower)) return glyph(Container, 'blue')
  if (/^tsconfig\..*json$/.test(lower)) return glyph(Braces, 'blue')
  // Teste em qualquer linguagem: o frasco verde, como o "verde de passou".
  if (/\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|(^test_.*|_test)\.py$|_spec\.rb$/.test(lower)) return glyph(FlaskConical, 'green')
  if (/^\..*ignore$/.test(lower)) return plain(EyeOff)
  const dot = lower.lastIndexOf('.')
  return (dot > 0 && BY_EXT[lower.slice(dot + 1)]) || plain(File)
}

// O squircle do ícone do app (superelipse), no grid de 16.
const SQUIRCLE =
  'M15 8L14.98 10.47L14.92 11.42L14.81 12.13L14.66 12.7L14.47 13.18L14.23 13.59L13.94 13.94L13.59 14.23L13.18 14.47L12.7 14.66L12.13 14.81L11.42 14.92L10.47 14.98L8 15L5.53 14.98L4.58 14.92L3.87 14.81L3.3 14.66L2.82 14.47L2.41 14.23L2.06 13.94L1.77 13.59L1.53 13.18L1.34 12.7L1.19 12.13L1.08 11.42L1.02 10.47L1 8L1.02 5.53L1.08 4.58L1.19 3.87L1.34 3.3L1.53 2.82L1.77 2.41L2.06 2.06L2.41 1.77L2.82 1.53L3.3 1.34L3.87 1.19L4.58 1.08L5.53 1.02L8 1L10.47 1.02L11.42 1.08L12.13 1.19L12.7 1.34L13.18 1.53L13.59 1.77L13.94 2.06L14.23 2.41L14.47 2.82L14.66 3.3L14.81 3.87L14.92 4.58L14.98 5.53Z'

// O asterisco do Claude (o mesmo do ClaudeMark), no grid de 24.
const CLAUDE =
  'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'

// As marcas desenhadas à mão, no grid de 16, para ir dentro do selo.
const MARKS = {
  // O "M↓" do Markdown.
  markdown: (
    <path
      d="M3.5 10.5v-5l2.25 2.5L8 5.5v5M11.25 5.5v4.75M9.6 8.75l1.65 1.65 1.65-1.65"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  // O átomo do React: TSX e JSX.
  react: (
    <g fill="none" stroke="currentColor" strokeWidth={0.95}>
      <ellipse cx="8" cy="8" rx="5.4" ry="2.1" />
      <ellipse cx="8" cy="8" rx="5.4" ry="2.1" transform="rotate(60 8 8)" />
      <ellipse cx="8" cy="8" rx="5.4" ry="2.1" transform="rotate(120 8 8)" />
      <circle cx="8" cy="8" r="1.05" fill="currentColor" stroke="none" />
    </g>
  ),
  claude: <path d={CLAUDE} fill="currentColor" transform="translate(3 3) scale(0.4167)" />,
}

// A sigla cabe no selo: quanto mais letras, menor.
const LETTER_SIZE = [0, 9, 7.6, 6.2]

function Selo({ look, className }: { look: Exclude<Look, { kind: 'plain' }>; className?: string }) {
  const size = look.kind === 'letters' ? LETTER_SIZE[Math.min(look.text.length, 3)] : 0
  return (
    <svg viewBox="0 0 16 16" className={cn('shrink-0', className)} aria-hidden>
      <g className={TONE[look.tone]}>
        <path d={SQUIRCLE} fill="currentColor" className="opacity-[0.14] dark:opacity-[0.2]" />
        {look.kind === 'letters' && (
          <text
            x="8"
            // Centrado na altura das maiúsculas da Geist (0,71 da fonte).
            y={8 + size * 0.355}
            textAnchor="middle"
            fontSize={size}
            fill="currentColor"
            className="font-sans font-bold tracking-[-0.03em] [font-variant-ligatures:none]"
          >
            {look.text}
          </text>
        )}
        {look.kind === 'glyph' && <look.icon x={3} y={3} size={10} absoluteStrokeWidth strokeWidth={1.25} />}
        {look.kind === 'mark' && MARKS[look.mark]}
      </g>
    </svg>
  )
}

/** O ícone de um arquivo pelo nome. A cor do resto (o cinza da folha) vem do `className`, como no lucide. */
export function FileIcon({ name, className }: { name: string; className?: string }) {
  const look = fileLook(name)
  if (look.kind === 'plain') return <look.icon className={cn('shrink-0', className)} aria-hidden />
  return <Selo look={look} className={className} />
}

type Badge = { icon: LucideIcon; tone?: Tone } | { claude: true }

const FOLDERS: Record<string, Badge> = {
  ...many('src source sources', { icon: Code, tone: 'blue' }),
  ...many('test tests __tests__ spec specs e2e testdata test-data fixtures __mocks__ mocks', { icon: FlaskConical, tone: 'green' }),
  ...many('docs doc documentation wiki', { icon: BookOpen, tone: 'sky' }),
  ...many('.github .gitlab .git .husky .githooks', { icon: GitBranch, tone: 'orange' }),
  ...many('scripts script bin cmd tools run tasks', { icon: Play, tone: 'purple' }),
  ...many('config configs conf settings .vscode .idea .config .devcontainer', { icon: Settings }),
  ...many('assets public static images img icons media resources', { icon: Image, tone: 'teal' }),
  ...many('components ui widgets', { icon: Blocks, tone: 'sky' }),
  ...many('lib libs packages pkg modules vendor third_party node_modules', { icon: Package, tone: 'yellow' }),
  ...many('server api backend services functions lambda', { icon: Server, tone: 'indigo' }),
  ...many('web www frontend client site', { icon: Globe, tone: 'sky' }),
  ...many('database db migrations prisma seeds schema sql', { icon: Database, tone: 'yellow' }),
  ...many('deploy infra .docker docker k8s kubernetes terraform ops helm ansible .circleci', { icon: Rocket, tone: 'rose' }),
  ...many('desktop electron windows macos linux src-tauri', { icon: Monitor }),
  android: { icon: Smartphone, tone: 'green' },
  ...many('mobile ios', { icon: Smartphone }),
  ...many('styles style css theme themes sass scss', { icon: Palette, tone: 'pink' }),
  ...many('utils util helpers', { icon: Wrench }),
  ...many('types typings @types', { icon: Type, tone: 'blue' }),
  ...many('locales locale i18n lang langs translations l10n', { icon: Languages, tone: 'teal' }),
  ...many('dist build out target .next .nuxt .output coverage release', { icon: Hammer }),
  ...many('pages routes views screens layouts templates', { icon: LayoutTemplate, tone: 'orange' }),
  ...many('examples example demo demos samples playground sandbox', { icon: Lightbulb, tone: 'yellow' }),
  ...many('.cache cache tmp temp logs log', { icon: History }),
  ...many('.claude claude', { claude: true }),
}

// As pastas do lucide, no grid de 24.
const FOLDER =
  'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'
const FOLDER_OPEN =
  'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'

/** A pasta, aberta ou fechada; as conhecidas (src, testes, scripts...) com o glifo delas no canto. */
export function FolderIcon({ name, open, className }: { name: string; open?: boolean; className?: string }) {
  const badge = FOLDERS[name.toLowerCase()]
  // O id da máscara vai num url(#...): só letras e números.
  const mask = `fm${useId().replace(/[^\w-]/g, '')}`
  const folder = (
    <path
      d={open ? FOLDER_OPEN : FOLDER}
      transform="scale(0.6667)"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  )
  return (
    <svg viewBox="0 0 16 16" className={cn('shrink-0', className)} aria-hidden>
      {badge ? (
        <>
          <mask id={mask}>
            <rect width="16" height="16" fill="white" />
            <circle cx="12" cy="12" r="5.2" fill="black" />
          </mask>
          <g mask={`url(#${mask})`}>{folder}</g>
          {'claude' in badge ? (
            <path d={CLAUDE} transform="translate(7.5 7.5) scale(0.375)" className="fill-[#d97757]" />
          ) : (
            <g className={badge.tone && TONE[badge.tone]}>
              <badge.icon x={7.5} y={7.5} size={9} absoluteStrokeWidth strokeWidth={1.3} />
            </g>
          )}
        </>
      ) : (
        folder
      )}
    </svg>
  )
}
