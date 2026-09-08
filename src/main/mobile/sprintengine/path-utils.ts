import { resolve } from 'path'

import { isPathInsideOrEqual } from '../../path-containment'

/** Re-exported: this module was the entry point its importers already had. */
export { isPathInsideOrEqual }

export function uniqueResolved(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))]
}

export function isSafePathSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && value !== '.' && value !== '..'
}

export function safeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return slug.slice(0, 80) || 'command'
}

export function mobileActorId(deviceId: string): string {
  return `mobile:${deviceId.replace(/[^A-Za-z0-9._:-]/gu, '_').slice(0, 120)}`
}
