// The file-type vocabulary: which kind of file is this row about, answered by
// shape alone. One glyph per kind, drawn on the 16-grid in `currentColor`, so
// the File Explorer, the Git changes list, and any other surface that names a
// file wear the SAME mark for the same kind (owner 2026-09-05).
//
// Familiar shapes make file kinds recognizable — the TS / JS / PY
// / RS / GO letter tiles, the React atom for `.tsx` / `.jsx`, `{}` for JSON,
// the M-with-arrow for Markdown, `<>` for HTML, `#` for stylesheets, the prompt
// for shell — and stay monochrome. The 2026-09-02 ruling that retired the
// sixteen hard-coded hex hues stands: category colour is not a status channel
// (principles.md → "Status hues are not accents … category code"), so the
// glyph inherits the row's ink and the status tint on the filename stays the
// one colour in the row. A `*.test.*` file wears its tile with the corner
// notched for a tick, the way IDEs badge a test source.
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
  | 'json'
  | 'markdown'
  | 'yaml'
  | 'html'
  | 'css'
  | 'shell'
  | 'python'
  | 'rust'
  | 'go'
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
  json: 'JSON',
  markdown: 'Markdown',
  yaml: 'YAML',
  html: 'HTML',
  css: 'Stylesheet',
  shell: 'Shell script',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
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

const TEST_SEGMENT = /\.(test|spec)$/

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
  const isTest = TEST_SEGMENT.test(stem)

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
      return 'react'
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
      return 'python'
    case 'rs':
      return 'rust'
    case 'go':
      return 'go'
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
  react: () => (
    <>
      <ellipse cx="8" cy="8" rx="6.25" ry="2.45" stroke="currentColor" strokeWidth="1.1" />
      <ellipse cx="8" cy="8" rx="6.25" ry="2.45" transform="rotate(60 8 8)" stroke="currentColor" strokeWidth="1.1" />
      <ellipse cx="8" cy="8" rx="6.25" ry="2.45" transform="rotate(120 8 8)" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" />
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
      <path
        d="M3.4 11.25V4.9h2.2c1.15 0 1.85.65 1.85 1.65S6.75 8.2 5.6 8.2H3.4M8.7 4.9l2 3.25 2-3.25M10.7 8.15v3.1"
        stroke="currentColor"
        strokeWidth={LETTER}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  rust: () => (
    <>
      <Tile />
      <path
        d="M3.2 11.25V4.9h2.2c1.1 0 1.8.65 1.8 1.6S6.5 8.1 5.4 8.1H3.2M5.5 8.1l1.9 3.15"
        stroke="currentColor"
        strokeWidth={LETTER}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <LetterS dx={0.3} />
    </>
  ),
  go: () => (
    <>
      <Tile />
      <path
        d="M7 5.85c-.55-.6-1.2-.95-2-.95C3.7 4.9 2.8 6.2 2.8 8.05s.9 3.15 2.2 3.15c1.15 0 2-.85 2-2.1v-.75H5.5"
        stroke="currentColor"
        strokeWidth={LETTER}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <ellipse cx="10.9" cy="8.05" rx="2.3" ry="3.15" stroke="currentColor" strokeWidth={LETTER} />
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

type FileTypeGlyphProps = {
  /** The file's name or path; the kind is derived from its last segment. */
  name?: string
  /** An already-resolved kind, when the caller has one. Wins over `name`. */
  kind?: FileTypeKind
  /** Sizing and ink stay with the caller; `icon-sm` is the row canon. */
  className?: string
  /**
   * Announce the kind. Off by default — the filename beside the glyph carries
   * the meaning, so the mark is decorative (glyphs/component.md, Accessibility).
   */
  labelled?: boolean
}

export function FileTypeGlyph({ name, kind, className = 'icon-sm shrink-0', labelled = false }: FileTypeGlyphProps): JSX.Element {
  const resolved = kind ?? fileTypeKind(name ?? '')
  const Body = BODY[resolved]
  const label = FILE_TYPE_LABEL[resolved]
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      {...(labelled ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {labelled ? <title>{label}</title> : null}
      <Body />
    </svg>
  )
}

/**
 * The folder mark for tree rows is outlined, in `currentColor` so it takes the row's ink. `open` swaps in the
 * lifted-flap drawing; the chevron beside it is what carries expanded state,
 * so a tree may leave `open` off and let the folder read the same either way.
 */
export function FolderGlyph({ open = false, className = 'icon-sm shrink-0' }: { open?: boolean; className?: string }): JSX.Element {
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
    </svg>
  )
}
