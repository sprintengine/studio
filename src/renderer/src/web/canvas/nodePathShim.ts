// What `node:path` is in the web client's build (vite.web.config.ts swaps the
// module for this one): POSIX paths, for the canvas service the web tab runs
// over a server's virtual roots (`/workspace/<id>/`, `/boards/<id>/`; see
// protocol-canvas-fs.ts), where a path is always POSIX whatever the machine.
// There is no working directory in a browser, so `resolve` starts from `/`.

export const sep = '/'
export const delimiter = ':'

export function normalize(path: string): string {
  if (path === '') return '.'
  const absolute = path.startsWith('/')
  const trailing = path.endsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!absolute) parts.push('..')
      continue
    }
    parts.push(part)
  }
  let out = parts.join('/')
  if (absolute) out = `/${out}`
  if (trailing && out !== '/' && out !== '') out += '/'
  return out || (absolute ? '/' : '.')
}

export function isAbsolute(path: string): boolean {
  return path.startsWith('/')
}

export function join(...parts: string[]): string {
  const joined = parts.filter((part) => part !== '').join('/')
  return joined === '' ? '.' : normalize(joined)
}

export function resolve(...parts: string[]): string {
  let resolved = ''
  for (let index = parts.length - 1; index >= 0 && !resolved.startsWith('/'); index--) {
    if (parts[index]) resolved = resolved ? `${parts[index]}/${resolved}` : parts[index]
  }
  const out = normalize(`/${resolved}`)
  return out.length > 1 && out.endsWith('/') ? out.slice(0, -1) : out
}

export function dirname(path: string): string {
  if (path === '') return '.'
  const trimmed = path.length > 1 ? path.replace(/\/+$/u, '') : path
  const at = trimmed.lastIndexOf('/')
  if (at < 0) return '.'
  if (at === 0) return '/'
  return trimmed.slice(0, at)
}

export function basename(path: string, suffix?: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/u, '') : path
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return suffix && base.endsWith(suffix) && base !== suffix ? base.slice(0, -suffix.length) : base
}

export function extname(path: string): string {
  const base = basename(path)
  const at = base.lastIndexOf('.')
  return at <= 0 ? '' : base.slice(at)
}

export function relative(from: string, to: string): string {
  const a = resolve(from).split('/').filter(Boolean)
  const b = resolve(to).split('/').filter(Boolean)
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common++
  return [...a.slice(common).map(() => '..'), ...b.slice(common)].join('/')
}

const pathApi = { sep, delimiter, normalize, isAbsolute, join, resolve, dirname, basename, extname, relative }

export const posix = pathApi
export default pathApi
