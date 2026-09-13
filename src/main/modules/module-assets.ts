import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative } from 'node:path'
import { MODULE_ASSET_SCHEME } from '../../shared/modules/assets'
import { resolveContainedPath } from './entry-containment'
import { isLoadEligible } from './module-signature'
import type { UserModuleListResult, InstalledModule } from './user-module-registry'

export const MODULE_ASSET_MAX_BYTES = 128 * 1024 * 1024
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.zip': 'application/zip',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
}

export type ModuleAssetBackends = {
  discoverModules(): Promise<UserModuleListResult>
  assetOrigin: (moduleId: string) => string
  isEnabled(module: InstalledModule, modules: InstalledModule[]): boolean
}

/** Every request rechecks trust and enablement; errors never expose disk paths. */
export function createModuleAssetHandler(backends: ModuleAssetBackends) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      const url = new URL(request.url)
      if (url.protocol !== `${MODULE_ASSET_SCHEME}:` || url.username || url.password || url.port) return new Response(null, { status: 400 })
      const { modules } = await backends.discoverModules()
      const installed = modules.find((module) => new URL(backends.assetOrigin(module.manifest.id)).hostname === url.hostname)
      if (!installed || !isLoadEligible(installed.trust.status) || !backends.isEnabled(installed, modules)) {
        return new Response(null, { status: 403 })
      }
      const path = decodeURIComponent(url.pathname.slice(1))
      if (!path || /[\\\0]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) return new Response(null, { status: 400 })
      const root = await realpath(installed.moduleRoot)
      const target = await realpath(resolveContainedPath(root, path, 'asset'))
      const within = relative(root, target)
      if (!within || within.startsWith('..') || isAbsolute(within)) return new Response(null, { status: 403 })
      file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await file.stat()
      if (!info.isFile()) return new Response(null, { status: 404 })
      if (info.size > MODULE_ASSET_MAX_BYTES) return new Response(null, { status: 413 })
      const headers = {
        'Content-Type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': String(info.size),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      }
      const bytes = request.method === 'HEAD' ? null : new Uint8Array(await file.readFile())
      return new Response(bytes, { status: 200, headers })
    } catch {
      return new Response(null, { status: 404 })
    } finally {
      await file?.close()
    }
  }
}

/** Chromium custom-protocol responses do not reliably enforce fetch CORS.
 * Gate frame requests before dispatch, using Chromium's frame identity rather
 * than a Referer supplied by page script. The default session has one owner of
 * onBeforeRequest; keep this filter scoped to the module scheme.
 */
export function isAllowedModuleAssetRequest(
  details: { url: string; resourceType: string; frame?: { url: string; parent: unknown } | null },
  shellUrl: string,
): boolean {
  type Frame = { url: string; parent: Frame | null }
  const isShell = (value: string) => {
    try {
      const candidate = new URL(value)
      const shell = new URL(shellUrl)
      return candidate.protocol === shell.protocol && candidate.host === shell.host && candidate.pathname === shell.pathname
    } catch { return false }
  }
  try {
    const target = new URL(details.url)
    let frame = details.frame as Frame | null | undefined
    if (!frame) return false
    let top = frame
    while (top.parent) top = top.parent
    if (!isShell(top.url)) return false
    if (details.resourceType === 'subFrame') frame = frame.parent
    if (!frame) return false
    if (isShell(frame.url)) return true
    const source = new URL(frame.url)
    return source.protocol === target.protocol && source.host === target.host
  } catch { return false }
}
