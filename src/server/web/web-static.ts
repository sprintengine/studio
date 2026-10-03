import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, relative, sep } from 'node:path'

// The web client's files, as the web listener serves them (phase 9 spec, 3.1).
//
// Static assets are public on purpose: the bundle is open source, nothing in
// it is per person, and a page that cannot load its own scripts before pairing
// cannot show a useful error. Hashed assets are cached for good; the fonts the
// editor asks for by a fixed name are cached for a day; the HTML is never
// cached, so a server upgrade is one reload away. Each file was compressed
// with brotli and gzip at build time and the variant the browser accepts is
// sent; nothing is compressed per request.

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

export type WebStaticRoot = {
  /** The directory `build:web` wrote (`out/web`). */
  directory: string
  /** The app page: small, and served on every app route. */
  indexHtml(): string | null
  /** The canvas worker's page, when the build carries it (the web client's `canvas` toolset). */
  canvasWorkerHtml(): string | null
  /** The embeddable conversation view's page. */
  embedHtml(): string | null
}

export function openWebStaticRoot(directory: string): WebStaticRoot {
  // Kept until the file changes, so a bundle rebuilt in place is served at once.
  const cache = new Map<string, { mtimeMs: number; text: string }>()
  const read = (name: string): string | null => {
    const path = join(directory, name)
    try {
      const { mtimeMs } = statSync(path)
      const kept = cache.get(name)
      if (kept && kept.mtimeMs === mtimeMs) return kept.text
      const text = readFileSync(path, 'utf8')
      cache.set(name, { mtimeMs, text })
      return text
    } catch {
      return null
    }
  }
  return {
    directory,
    indexHtml: () => read('index.html'),
    canvasWorkerHtml: () => read('canvas-worker.html'),
    embedHtml: () => read('embed.html'),
  }
}

/** A request path as a file under the root, or null when it would leave the root or names no file. */
export function resolveStaticFile(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const candidate = normalize(join(root, decoded))
  const inside = relative(root, candidate)
  if (!inside || inside.startsWith('..') || inside.split(sep).includes('..')) return null
  // Dotfiles (a stray `.DS_Store`, an editor's swap file) are not the app.
  if (inside.split(sep).some((part) => part.startsWith('.'))) return null
  try {
    return statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

/** How long a path may be cached: hashed assets for good, fixed-name fonts for a day, the rest never. */
export function cacheControlFor(pathname: string): string {
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  if (pathname.startsWith('/fonts/')) return 'public, max-age=86400'
  return 'no-store'
}

function acceptsEncoding(request: IncomingMessage, encoding: 'br' | 'gzip'): boolean {
  const header = request.headers['accept-encoding']
  const value = Array.isArray(header) ? header.join(',') : (header ?? '')
  return value
    .split(',')
    .map((part) => part.trim().split(';'))
    .some(([name, ...params]) => name === encoding && !params.some((param) => /^q=0(\.0*)?$/u.test(param.trim())))
}

/** Serve one static file, choosing a precompressed variant when one exists and the browser takes it. */
export function serveStaticFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: string,
  pathname: string,
  extraHeaders: Record<string, string> = {},
): void {
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  let path = file
  let encoding: string | null = null
  for (const [candidate, suffix] of [
    ['br', '.br'],
    ['gzip', '.gz'],
  ] as const) {
    if (acceptsEncoding(request, candidate) && existsSync(`${file}${suffix}`)) {
      path = `${file}${suffix}`
      encoding = candidate
      break
    }
  }
  const size = statSync(path).size
  response.writeHead(200, {
    'Content-Type': type,
    'Content-Length': String(size),
    'Cache-Control': cacheControlFor(pathname),
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Accept-Encoding',
    ...(encoding ? { 'Content-Encoding': encoding } : {}),
    ...extraHeaders,
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(path).pipe(response)
}
