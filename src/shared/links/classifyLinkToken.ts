export type LinkTokenContext = {
  source: 'href' | 'inlineCode' | 'text'
  cwd?: string
  platform: string
}

export type LinkToken = { type: 'file'; path: string; line?: number; col?: number } | { type: 'url'; href: string }

export const FILE_EXTENSIONS: ReadonlySet<string> = Object.freeze(
  new Set([
    'astro',
    'bash',
    'bat',
    'c',
    'cc',
    'cfg',
    'cjs',
    'clj',
    'conf',
    'cpp',
    'cs',
    'css',
    'csv',
    'cts',
    'dart',
    'diff',
    'dockerfile',
    'env',
    'ex',
    'exs',
    'fish',
    'go',
    'graphql',
    'h',
    'hpp',
    'html',
    'ini',
    'java',
    'jl',
    'js',
    'json',
    'jsonc',
    'jsx',
    'kt',
    'kts',
    'less',
    'lock',
    'lua',
    'm',
    'md',
    'mdx',
    'mjs',
    'mts',
    'php',
    'pl',
    'proto',
    'ps1',
    'py',
    'r',
    'rb',
    'rs',
    'sass',
    'scss',
    'sh',
    'sql',
    'svelte',
    'swift',
    'toml',
    'ts',
    'tsx',
    'txt',
    'vue',
    'xml',
    'yaml',
    'yml',
    'zig',
  ]),
)

export const EXTENSIONLESS_FILES: ReadonlySet<string> = Object.freeze(
  new Set([
    'Makefile',
    'Dockerfile',
    'Procfile',
    'Gemfile',
    'Rakefile',
    'Justfile',
    'Brewfile',
    'Vagrantfile',
    'LICENSE',
    'README',
    'CHANGELOG',
    'CODEOWNERS',
    'AUTHORS',
    'NOTICE',
  ]),
)

export const HOST_TLDS: ReadonlySet<string> = Object.freeze(
  new Set([
    'app',
    'au',
    'be',
    'biz',
    'br',
    'ca',
    'ch',
    'cloud',
    'cn',
    'co',
    'com',
    'de',
    'dev',
    'dk',
    'edu',
    'es',
    'eu',
    'fi',
    'fr',
    'gov',
    'gr',
    'ie',
    'in',
    'info',
    'io',
    'it',
    'jp',
    'kr',
    'me',
    'mil',
    'net',
    'nl',
    'no',
    'nz',
    'online',
    'org',
    'pl',
    'pt',
    'ru',
    'se',
    'shop',
    'site',
    'tech',
    'tv',
    'uk',
    'us',
    'xyz',
    'za',
  ]),
)

const FILE_ROOTS = new Set([
  'Users',
  'home',
  'tmp',
  'var',
  'etc',
  'opt',
  'usr',
  'private',
  'Volumes',
  'mnt',
  'workspace',
  'workspaces',
  'root',
  'srv',
])

function stripTrailing(value: string): string {
  let end = value.length
  while (end > 0) {
    const last = value[end - 1]
    if ('.,;:!?'.includes(last)) {
      end--
      continue
    }
    const opener = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : null
    if (!opener && last !== "'" && last !== '"') break
    let balance = 0
    for (let i = 0; i < end; i++) {
      if (value[i] === (opener ?? last)) balance++
      if (opener && value[i] === last) balance--
    }
    if (opener ? balance > 0 : balance % 2 === 0) break
    end--
  }
  return value.slice(0, end)
}

function parsePosition(value: string): { value: string; line?: number; col?: number } {
  const hash = /#L(\d+)(?:C(\d+)|-L\d+)?$/u.exec(value)
  const colon = hash ? null : /:(\d+)(?::(\d+))?$/u.exec(value)
  const match = hash ?? colon
  if (!match) return { value }
  const line = Number(match[1])
  const col = match[2] === undefined ? undefined : Number(match[2])
  if (!Number.isSafeInteger(line) || line < 1 || (col !== undefined && (!Number.isSafeInteger(col) || col < 1))) {
    return { value }
  }
  return { value: value.slice(0, match.index), line, col }
}

function knownFileName(value: string): boolean {
  const name = value.slice(value.lastIndexOf('/') + 1)
  if (EXTENSIONLESS_FILES.has(name) || (name.startsWith('.') && name.length > 1)) return true
  const dot = name.lastIndexOf('.')
  return dot > 0 && FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

function underCwd(path: string, cwd: string | undefined): boolean {
  if (!cwd) return false
  const root = cwd.replace(/\\/gu, '/').replace(/\/+$/u, '')
  return path === root || path.startsWith(`${root}/`)
}

function hostLookalike(value: string): boolean {
  const first = value.slice(0, value.indexOf('/'))
  if (!first || first.includes('\\')) return false
  const match = /^[a-z0-9-]+\.([a-z]{2,})$/iu.exec(first)
  return !!match && HOST_TLDS.has(match[1].toLowerCase())
}

/** Classify one already-delimited token without looking at the filesystem. */
export function classifyLinkToken(token: string, ctx: LinkTokenContext): LinkToken | null {
  try {
    if (typeof token !== 'string' || token.length > 2048) return null
    const cleaned = stripTrailing(token.trim())
    if (!cleaned) return null

    const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(cleaned)?.[1]?.toLowerCase()
    if (
      scheme &&
      !(/^[a-z]$/iu.test(scheme) && /^[a-z]:[\\/]/iu.test(cleaned)) &&
      !(/^\d+(?::\d+)?$/u.test(cleaned.slice(scheme.length + 1)) && scheme !== 'http' && scheme !== 'https')
    ) {
      if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return { type: 'url', href: cleaned }
      if (scheme !== 'file') return null
      const location = parsePosition(cleaned.slice(5))
      const rawPath = location.value.replace(/^\/\//u, '')
      const decoded = decodeURIComponent(/^\/[a-z]:\//iu.test(rawPath) ? rawPath.slice(1) : rawPath)
      return {
        type: 'file',
        path: decoded,
        ...(location.line ? { line: location.line } : {}),
        ...(location.col ? { col: location.col } : {}),
      }
    }

    const position = parsePosition(cleaned)
    const value = position.value
    const file = (): LinkToken => ({
      type: 'file',
      path: value,
      ...(position.line ? { line: position.line } : {}),
      ...(position.col ? { col: position.col } : {}),
    })

    if (value.startsWith('./') || value.startsWith('../') || value.startsWith('~/')) return file()
    if (/^[a-z]:[\\/]/iu.test(value) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.test(value)) return file()
    if (value.startsWith('/')) {
      const first = value.slice(1).split('/', 1)[0]
      return FILE_ROOTS.has(first) || underCwd(value, ctx.cwd) ? file() : null
    }
    if (value.includes('/') && !value.includes('\\')) {
      if (knownFileName(value)) return file()
      return hostLookalike(value) ? { type: 'url', href: cleaned } : null
    }
    if (ctx.source === 'text') return null
    return (knownFileName(value) && (value.includes('.') || position.line !== undefined)) || position.line !== undefined
      ? file()
      : null
  } catch {
    return null
  }
}
