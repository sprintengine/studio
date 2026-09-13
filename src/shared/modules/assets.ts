/** Stable, per-module origins for packaged HTML, WASM, workers and saved game storage. */
export const MODULE_ASSET_SCHEME = 'studio-module'

export function moduleAssetHost(moduleId: string): string {
  return Array.from(new TextEncoder().encode(moduleId), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function moduleAssetUrl(moduleId: string, relativePath: string, origin?: string): string {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.startsWith('/') || /[\\\0?#]/.test(relativePath)) {
    throw new Error('Asset path must be a module-relative file path.')
  }
  const parts = relativePath.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Asset path must stay inside the module directory.')
  }
  return `${origin ?? `${MODULE_ASSET_SCHEME}://${moduleAssetHost(moduleId)}`}/${parts.map(encodeURIComponent).join('/')}`
}
