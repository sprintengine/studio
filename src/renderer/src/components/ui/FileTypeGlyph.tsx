// The file-type vocabulary: which kind of file is this row about, answered by
// shape alone. One glyph per kind, drawn on the 16-grid in `currentColor`, so
// the File Explorer, the Git changes list, and any other surface that names a
// file wear the SAME mark for the same kind (owner 2026-09-05).
//
// Familiar shapes make file kinds recognizable — the TS / JS / PY
// / RS / GO letter tiles, the React atom for `.tsx` / `.jsx`, `{}` for JSON,
// the M-with-arrow for Markdown, `<>` for HTML, `#` for stylesheets, the prompt
// for shell. A `*.test.*` file wears its tile with the corner notched for a
// tick, the way IDEs badge a test source.
//
// Colour is an axis, `tone`, and the caller picks it (owner, 2026-09-06,
// principles.md → "Identity colour"). `ink`, the default, is the glyph the
// 2026-09-02 ruling left: it inherits the row's ink, so in a list where the
// filename already carries a status tint (the Git changes list) that tint stays
// the one colour in the row. `kind` inks the glyph in its kind's identity hue —
// the `--sem-color-mark-*` tokens, blue for TypeScript, yellow for JavaScript
// — the way IDEs colour their project views, so a
// tree of forty files can be scanned by colour before it is read. The hue
// identifies; it never grades. The drawing is the same in both tones.
//
// 16-grid stroke discipline (glyphs/component.md): frame 1.2, line work 1.3–1.4,
// the letterforms a step heavier at 1.45 so they hold at 16px.

import React from 'react'

export type FileTypeKind =
  | 'typescript'
  | 'typescript-test'
  | 'javascript'
  | 'javascript-test'
  | 'react'
  | 'react-test'
  | 'json'
  | 'markdown'
  | 'yaml'
  | 'html'
  | 'css'
  | 'shell'
  | 'python'
  | 'python-test'
  | 'rust'
  | 'rust-test'
  | 'go'
  | 'go-test'
  | 'java'
  | 'image'
  | 'lock'
  | 'config'
  | 'text'
  | 'generic'

/** The kind's name for an `aria-label` or a tooltip, when a caller wants one. */
export const FILE_TYPE_LABEL: Record<FileTypeKind, string> = {
  typescript: 'TypeScript',
  'typescript-test': 'TypeScript test',
  javascript: 'JavaScript',
  'javascript-test': 'JavaScript test',
  react: 'React component',
  'react-test': 'React component test',
  json: 'JSON',
  markdown: 'Markdown',
  yaml: 'YAML',
  html: 'HTML',
  css: 'Stylesheet',
  shell: 'Shell script',
  python: 'Python',
  'python-test': 'Python test',
  rust: 'Rust',
  'rust-test': 'Rust test',
  go: 'Go',
  'go-test': 'Go test',
  java: 'Java',
  image: 'Image',
  lock: 'Lockfile',
  config: 'Configuration',
  text: 'Text',
  generic: 'File',
}

const LOCKFILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'cargo.lock',
  'poetry.lock',
  'gemfile.lock',
  'composer.lock',
  'go.sum',
])

const CONFIG_BASENAMES = new Set([
  'dockerfile',
  'makefile',
  'procfile',
  '.editorconfig',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.npmrc',
  '.nvmrc',
  '.prettierrc',
  '.eslintrc',
  '.babelrc',
  '.dockerignore',
  '.env',
])

const TEXT_BASENAMES = new Set(['license', 'licence', 'readme', 'changelog', 'authors', 'notice', 'copying'])

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'apng', 'bmp', 'ico', 'svg', 'icns'])

const CONFIG_EXTENSIONS = new Set(['toml', 'ini', 'cfg', 'conf', 'properties', 'plist', 'xml', 'env'])

const TEXT_EXTENSIONS = new Set(['txt', 'log', 'csv', 'tsv', 'rtf', 'pdf', 'doc', 'docx'])

const SHELL_EXTENSIONS = new Set(['sh', 'bash', 'zsh', 'fish', 'ksh', 'bat', 'cmd', 'ps1'])

// The test-naming conventions the tree recognises, by language family. Each is
// gated on the extension it belongs to rather than tried against every name,
// because the forms genuinely collide across languages.
//
// `.test.` / `.spec.` is the JS/TS infix. `test_` and `_test` are the Python /
// Go / Rust convention. `FooTest` / `FooTests` / `FooIT` is JUnit's, and it is
// matched on the ORIGINAL case on purpose: lowercased, a bare `test` suffix
// also swallows `latest`, `fastest` and `manifest`, and every one of them would
// wear the tick.
const TEST_INFIX = /\.(test|spec)$/
const TEST_PREFIX = /^test_/
const TEST_SUFFIX = /_test$/
const JAVA_TEST_SUFFIX = /(?:Test|Tests|IT)$/

// Directory names that make everything beneath them a test, whatever the file
// is called — `tests/foo.py` carries no marker of its own.
const TEST_DIRECTORIES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'testing'])


/**
 * Does this file name follow a test-naming convention? Basename only, and
 * gated on the extension — a file that is a test purely because of the folder
 * it sits in is answered by `isTestPath` instead. Pure, so a 500-row tree may
 * call it per row per render.
 */
export function isTestBasename(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return false
  const ext = base.slice(dot + 1).toLowerCase()
  const stem = base.slice(0, dot)
  const lowerStem = stem.toLowerCase()

  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'tsx':
    case 'jsx':
      return TEST_INFIX.test(lowerStem)
    case 'py':
    case 'pyi':
      return TEST_INFIX.test(lowerStem) || TEST_PREFIX.test(lowerStem) || TEST_SUFFIX.test(lowerStem)
    case 'go':
    case 'rs':
      return TEST_SUFFIX.test(lowerStem)
    case 'java':
    case 'kt':
      return JAVA_TEST_SUFFIX.test(stem)
    default:
      return false
  }
}

/**
 * Is this path a test — by its own name, or by sitting under a `tests/`-family
 * directory? Pass a path RELATIVE to the tree's root: an absolute one drags in
 * the machine's own directory names, and a checkout living under `~/testing`
 * would answer yes for every file in it.
 */
export function isTestPath(path: string): boolean {
  const segments = path.split(/[\\/]+/).filter(Boolean)
  const base = segments.pop()
  if (!base) return false
  if (isTestBasename(base)) return true
  return segments.some((segment) => TEST_DIRECTORIES.has(segment.toLowerCase()))
}

/**
 * Resolve a file name (or path — only the last segment is read) to its kind.
 * Pure: the same name always answers the same way, so a 500-row list can call
 * it per render without caching.
 */
export function fileTypeKind(name: string): FileTypeKind {
  const base = name.split(/[\\/]/).pop() ?? name
  const lower = base.toLowerCase()

  if (LOCKFILES.has(lower)) return 'lock'
  if (CONFIG_BASENAMES.has(lower) || lower.startsWith('.env.')) return 'config'

  const dot = lower.lastIndexOf('.')
  // No extension (`LICENSE`, `Makefile`) or a bare dotfile (`.zshrc`).
  if (dot <= 0) {
    if (TEXT_BASENAMES.has(lower)) return 'text'
    return lower.startsWith('.') ? 'config' : 'generic'
  }
  const ext = lower.slice(dot + 1)
  const stem = lower.slice(0, dot)
  if (TEXT_BASENAMES.has(stem) && (ext === 'md' || ext === 'txt')) {
    return ext === 'md' ? 'markdown' : 'text'
  }
  const isTest = isTestBasename(base)

  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return isTest ? 'typescript-test' : 'typescript'
    case 'js':
    case 'mjs':
    case 'cjs':
      return isTest ? 'javascript-test' : 'javascript'
    case 'tsx':
    case 'jsx':
      return isTest ? 'react-test' : 'react'
    case 'json':
    case 'jsonc':
    case 'json5':
      return 'json'
    case 'md':
    case 'mdx':
    case 'markdown':
      return 'markdown'
    case 'yaml':
    case 'yml':
      return 'yaml'
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
      return 'html'
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return 'css'
    case 'py':
    case 'pyi':
      return isTest ? 'python-test' : 'python'
    case 'rs':
      return isTest ? 'rust-test' : 'rust'
    case 'go':
      return isTest ? 'go-test' : 'go'
    case 'java':
    case 'kt':
    case 'kts':
      return 'java'
    case 'lock':
      return 'lock'
    default:
      if (SHELL_EXTENSIONS.has(ext)) return 'shell'
      if (IMAGE_EXTENSIONS.has(ext)) return 'image'
      if (CONFIG_EXTENSIONS.has(ext)) return 'config'
      if (TEXT_EXTENSIONS.has(ext)) return 'text'
      return 'generic'
  }
}

// ---------------------------------------------------------------------------
// Drawing. Shared parts first: the letter tile, its notched twin for tests, the
// tick that sits in the notch, and the S that TS / JS / RS share.

const FRAME = 1.2
const LINE = 1.3
const MARK = 1.4
const LETTER = 1.45

const Tile = () => <rect x="1.5" y="1.5" width="13" height="13" rx="2.25" stroke="currentColor" strokeWidth={FRAME} />

// The same tile with the bottom-right corner left open, so the test tick sits
// IN the frame rather than across it — across it, the tick read as noise at 16px.
const NotchedTile = () => (
  <path
    d="M14.5 8.75V3.75c0-1.24-1-2.25-2.25-2.25H3.75C2.5 1.5 1.5 2.5 1.5 3.75v8.5c0 1.24 1 2.25 2.25 2.25h5"
    stroke="currentColor"
    strokeWidth={FRAME}
    strokeLinecap="round"
  />
)

const TestTick = () => (
  <path d="M10.5 12.4l1.5 1.6 2.75-3.1" stroke="currentColor" strokeWidth={LETTER} strokeLinecap="round" strokeLinejoin="round" />
)

const LetterS = ({ dx = 0 }: { dx?: number }) => (
  <path
    transform={dx ? `translate(${dx} 0)` : undefined}
    d="M12.35 5.85c-.5-.65-1.25-1-2.05-1-1.15 0-1.9.6-1.9 1.45 0 .95.8 1.25 1.9 1.55 1.15.3 2 .75 2 1.8 0 1-.85 1.65-2.1 1.65-.95 0-1.7-.4-2.25-1.05"
    stroke="currentColor"
    strokeWidth={LETTER}
    strokeLinecap="round"
  />
)

const LetterT = () => <path d="M3.1 4.9h4.2M5.2 4.9v6.35" stroke="currentColor" strokeWidth={LETTER} strokeLinecap="round" />

const LetterJ = () => (
  <path d="M7 4.9v4.45c0 1.15-.75 1.9-1.8 1.9-.9 0-1.55-.45-1.85-1.15" stroke="currentColor" strokeWidth={LETTER} strokeLinecap="round" />
)

const LettersPy = () => (
  <path
    d="M3.4 11.25V4.9h2.2c1.15 0 1.85.65 1.85 1.65S6.75 8.2 5.6 8.2H3.4M8.7 4.9l2 3.25 2-3.25M10.7 8.15v3.1"
    stroke="currentColor"
    strokeWidth={LETTER}
    strokeLinecap="round"
    strokeLinejoin="round"
  />
)

const LettersRs = () => (
  <>
    <path
      d="M3.2 11.25V4.9h2.2c1.1 0 1.8.65 1.8 1.6S6.5 8.1 5.4 8.1H3.2M5.5 8.1l1.9 3.15"
      stroke="currentColor"
      strokeWidth={LETTER}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <LetterS dx={0.3} />
  </>
)

const LettersGo = () => (
  <>
    <path
      d="M7 5.85c-.55-.6-1.2-.95-2-.95C3.7 4.9 2.8 6.2 2.8 8.05s.9 3.15 2.2 3.15c1.15 0 2-.85 2-2.1v-.75H5.5"
      stroke="currentColor"
      strokeWidth={LETTER}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <ellipse cx="10.9" cy="8.05" rx="2.3" ry="3.15" stroke="currentColor" strokeWidth={LETTER} />
  </>
)

const ReactAtom = ({ strokeWidth = '1.1' }: { strokeWidth?: string }) => (
  <>
    <ellipse cx="8" cy="8" rx="6.25" ry="2.45" stroke="currentColor" strokeWidth={strokeWidth} />
    <ellipse cx="8" cy="8" rx="6.25" ry="2.45" transform="rotate(60 8 8)" stroke="currentColor" strokeWidth={strokeWidth} />
    <ellipse cx="8" cy="8" rx="6.25" ry="2.45" transform="rotate(120 8 8)" stroke="currentColor" strokeWidth={strokeWidth} />
    <circle cx="8" cy="8" r="1.15" fill="currentColor" />
  </>
)

const DocumentOutline = () => (
  <>
    <path
      d="M4.25 1.75h5.4l2.1 2.1v10.4H4.25a1.5 1.5 0 0 1-1.5-1.5v-9.5a1.5 1.5 0 0 1 1.5-1.5Z"
      stroke="currentColor"
      strokeWidth={LINE}
      strokeLinejoin="round"
    />
    <path d="M9.5 1.9v2.25h2.25" stroke="currentColor" strokeWidth={LINE} strokeLinecap="round" strokeLinejoin="round" />
  </>
)

const BODY: Record<FileTypeKind, () => JSX.Element> = {
  typescript: () => (
    <>
      <Tile />
      <LetterT />
      <LetterS />
    </>
  ),
  'typescript-test': () => (
    <>
      <NotchedTile />
      <LetterT />
      <LetterS />
      <TestTick />
    </>
  ),
  javascript: () => (
    <>
      <Tile />
      <LetterJ />
      <LetterS />
    </>
  ),
  'javascript-test': () => (
    <>
      <NotchedTile />
      <LetterJ />
      <LetterS />
      <TestTick />
    </>
  ),
  react: () => <ReactAtom />,
  // The atom has no frame to notch, so the test twin shrinks it up and left and
  // drops the tick into the corner the shrink just cleared. The stroke is set a
  // step heavy because the group scale thins it back to the 1.1 the plain atom
  // draws at.
  'react-test': () => (
    <>
      <g transform="translate(0.36 0.36) scale(0.78)">
        <ReactAtom strokeWidth="1.41" />
      </g>
      <TestTick />
    </>
  ),
  json: () => (
    <path
      d="M6.1 2.75c-1.3 0-1.9.6-1.9 1.75v1.65c0 .95-.55 1.55-1.6 1.85 1.05.3 1.6.9 1.6 1.85v1.65c0 1.15.6 1.75 1.9 1.75M9.9 2.75c1.3 0 1.9.6 1.9 1.75v1.65c0 .95.55 1.55 1.6 1.85-1.05.3-1.6.9-1.6 1.85v1.65c0 1.15-.6 1.75-1.9 1.75"
      stroke="currentColor"
      strokeWidth={MARK}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  markdown: () => (
    <>
      <path d="M2 11.25V4.9l2.95 3.5L7.9 4.9v6.35" stroke="currentColor" strokeWidth={MARK} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.75 4.9v6.1M9.55 8.85l2.2 2.3 2.2-2.3" stroke="currentColor" strokeWidth={MARK} strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  yaml: () => (
    <path
      d="M2.75 4.25h1.5M6.75 4.25h6.5M4.75 8h1.5M8.75 8h4.5M4.75 11.75h1.5M8.75 11.75h4.5"
      stroke="currentColor"
      strokeWidth={MARK}
      strokeLinecap="round"
    />
  ),
  html: () => (
    <path d="M5.5 4.5 2.25 8l3.25 3.5M10.5 4.5 13.75 8l-3.25 3.5" stroke="currentColor" strokeWidth={MARK} strokeLinecap="round" strokeLinejoin="round" />
  ),
  css: () => <path d="M6.4 3 5.1 13M10.9 3 9.6 13M3.25 6.2h10M2.75 9.8h10" stroke="currentColor" strokeWidth={MARK} strokeLinecap="round" />,
  shell: () => (
    <path d="M2.75 4.25 6.5 8l-3.75 3.75M8.25 11.75h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  ),
  python: () => (
    <>
      <Tile />
      <LettersPy />
    </>
  ),
  'python-test': () => (
    <>
      <NotchedTile />
      <LettersPy />
      <TestTick />
    </>
  ),
  rust: () => (
    <>
      <Tile />
      <LettersRs />
    </>
  ),
  'rust-test': () => (
    <>
      <NotchedTile />
      <LettersRs />
      <TestTick />
    </>
  ),
  go: () => (
    <>
      <Tile />
      <LettersGo />
    </>
  ),
  // GO is the one pair whose letters reach into the notch: the O is a closed
  // ellipse out at x13.2/y11.2, and drawn at full size it and the tick merge
  // into a smudge at 16px. TS/JS/PY/RS all end in thin strokes there and need
  // no such nudge. Lifted up and left just far enough to clear the tick.
  'go-test': () => (
    <>
      <NotchedTile />
      <g transform="translate(-0.9 -1.1) scale(0.92)">
        <LettersGo />
      </g>
      <TestTick />
    </>
  ),
  java: () => (
    <path
      d="M3.25 6.75h7.5v3.25a3 3 0 0 1-3 3h-1.5a3 3 0 0 1-3-3zM10.75 7.75h1.1a1.55 1.55 0 0 1 0 3.1h-1.1M5.75 2.25c.7.7.7 1.4 0 2.1M8.25 2.25c.7.7.7 1.4 0 2.1"
      stroke="currentColor"
      strokeWidth={LINE}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  image: () => (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth={LINE} />
      <circle cx="5.6" cy="6.4" r="1.1" stroke="currentColor" strokeWidth={FRAME} />
      <path d="M2.4 11.6 6 8.3l2.4 2.2 2-1.8 3.2 2.9" stroke="currentColor" strokeWidth={LINE} strokeLinejoin="round" />
    </>
  ),
  lock: () => (
    <>
      <rect x="3.5" y="7" width="9" height="6" rx="1.4" stroke="currentColor" strokeWidth={MARK} />
      <path d="M5.5 7V5.4a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth={MARK} />
    </>
  ),
  config: () => (
    <>
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth={LINE} />
      <path
        d="M8 1.9v1.7M8 12.4v1.7M1.9 8h1.7M12.4 8h1.7M3.7 3.7l1.2 1.2M11.1 11.1l1.2 1.2M3.7 12.3l1.2-1.2M11.1 4.9l1.2-1.2"
        stroke="currentColor"
        strokeWidth={LINE}
        strokeLinecap="round"
      />
      <circle cx="8" cy="8" r="4.3" stroke="currentColor" strokeWidth={LINE} />
    </>
  ),
  text: () => (
    <>
      <DocumentOutline />
      <path d="M5.25 7.25h4M5.25 9.75h4M5.25 12.25h2.5" stroke="currentColor" strokeWidth={LINE} strokeLinecap="round" />
    </>
  ),
  generic: () => <DocumentOutline />,
}

/**
 * How the glyph is inked. `ink` takes the surrounding text colour (the default,
 * and the rule for any list whose filenames carry a status tint). `kind` wears
 * the kind's identity hue from the `--sem-color-mark-*` ramp — for the File
 * Explorer, where nothing else in the row is coloured.
 */
type FileTypeGlyphTone = 'ink' | 'kind'

// Kind → identity hue. The pairings are the ones people already know from
// their editors: TypeScript blue, JavaScript yellow, Python blue, HTML orange,
// Rust orange, Go cyan, React cyan, YAML red, Java red, shell teal, CSS and
// images violet, JSON and lockfiles yellow. Configuration, plain text and the
// generic document stay in the row's ink: they name no language, and a gear or
// a page in a colour would be colour saying nothing.
//
// Literal class strings, never interpolated: Tailwind generates an arbitrary
// colour utility only from a variant it can see in the source text.
const KIND_INK: Record<FileTypeKind, string | null> = {
  typescript: 'text-[color:var(--sem-color-mark-blue)]',
  'typescript-test': 'text-[color:var(--sem-color-mark-blue)]',
  javascript: 'text-[color:var(--sem-color-mark-yellow)]',
  'javascript-test': 'text-[color:var(--sem-color-mark-yellow)]',
  react: 'text-[color:var(--sem-color-mark-cyan)]',
  'react-test': 'text-[color:var(--sem-color-mark-cyan)]',
  json: 'text-[color:var(--sem-color-mark-yellow)]',
  markdown: 'text-[color:var(--sem-color-mark-blue)]',
  yaml: 'text-[color:var(--sem-color-mark-red)]',
  html: 'text-[color:var(--sem-color-mark-orange)]',
  css: 'text-[color:var(--sem-color-mark-violet)]',
  shell: 'text-[color:var(--sem-color-mark-teal)]',
  python: 'text-[color:var(--sem-color-mark-blue)]',
  'python-test': 'text-[color:var(--sem-color-mark-blue)]',
  rust: 'text-[color:var(--sem-color-mark-orange)]',
  'rust-test': 'text-[color:var(--sem-color-mark-orange)]',
  go: 'text-[color:var(--sem-color-mark-cyan)]',
  'go-test': 'text-[color:var(--sem-color-mark-cyan)]',
  java: 'text-[color:var(--sem-color-mark-red)]',
  image: 'text-[color:var(--sem-color-mark-violet)]',
  lock: 'text-[color:var(--sem-color-mark-yellow)]',
  config: null,
  text: null,
  generic: null,
}

type FileTypeGlyphProps = {
  /** The file's name or path; the kind is derived from its last segment. */
  name?: string
  /** An already-resolved kind, when the caller has one. Wins over `name`. */
  kind?: FileTypeKind
  /** Sizing stays with the caller; `icon-sm` is the row canon. Ink too, under `tone="ink"`. */
  className?: string
  /** `ink` (default) inherits the surrounding text colour; `kind` wears the kind's identity hue. */
  tone?: FileTypeGlyphTone
  /**
   * Announce the kind. Off by default — the filename beside the glyph carries
   * the meaning, so the mark is decorative (glyphs/component.md, Accessibility).
   */
  labelled?: boolean
}

export function FileTypeGlyph({
  name,
  kind,
  className = 'icon-sm shrink-0',
  tone = 'ink',
  labelled = false,
}: FileTypeGlyphProps): JSX.Element {
  const resolved = kind ?? fileTypeKind(name ?? '')
  const Body = BODY[resolved]
  const label = FILE_TYPE_LABEL[resolved]
  const kindInk = tone === 'kind' ? KIND_INK[resolved] : null
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={kindInk ? `${className} ${kindInk}` : className}
      data-tone={kindInk ? 'kind' : undefined}
      {...(labelled ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {labelled ? <title>{label}</title> : null}
      <Body />
    </svg>
  )
}

/**
 * The overlay that separates two roles wearing the same ink. `generated` takes
 * an asterisk (machine-written); `resources` takes its stacked bars.
 * The plain roles — sources, test sources, excluded — carry no badge, because
 * their ink already tells them apart from each other.
 *
 * Both are drawn in the bottom-right corner and the folder path is unchanged
 * beneath them: one drawing, differenced by a mark, so a folder still reads as
 * a folder at 16px.
 */
export type FolderBadge = 'generated' | 'resources'

const FolderBadgeMark = ({ badge }: { badge: FolderBadge }) =>
  badge === 'generated' ? (
    <path
      d="M11.9 8.6v4.2M10 9.65l3.8 2.1M13.8 9.65l-3.8 2.1"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinecap="round"
    />
  ) : (
    <path d="M10.2 9.4h3.9M10.2 11.1h3.9M10.2 12.8h3.9" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
  )

/**
 * The folder mark for tree rows is outlined, in `currentColor` so it takes the row's ink. `open` swaps in the
 * lifted-flap drawing; the chevron beside it is what carries expanded state,
 * so a tree may leave `open` off and let the folder read the same either way.
 */
export function FolderGlyph({
  open = false,
  className = 'icon-sm shrink-0',
  badge,
}: {
  open?: boolean
  className?: string
  badge?: FolderBadge
}): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      {open ? (
        <>
          <path
            d="M1.75 4.75c0-.83.67-1.5 1.5-1.5h3.1l1.5 1.5h5.4c.83 0 1.5.67 1.5 1.5v1.25"
            stroke="currentColor"
            strokeWidth={LINE}
            strokeLinejoin="round"
          />
          <path
            d="M1.75 12.25V7.9c0-.5.4-.9.9-.9h10.9c.6 0 1 .55.85 1.1l-1.05 3.9c-.12.45-.5.75-.95.75H3.25c-.83 0-1.5-.67-1.5-1.5z"
            stroke="currentColor"
            strokeWidth={LINE}
            strokeLinejoin="round"
          />
        </>
      ) : (
        <path
          d="M1.75 4.75c0-.83.67-1.5 1.5-1.5h3.1l1.5 1.5h5.4c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5z"
          stroke="currentColor"
          strokeWidth={LINE}
          strokeLinejoin="round"
        />
      )}
      {badge ? <FolderBadgeMark badge={badge} /> : null}
    </svg>
  )
}
