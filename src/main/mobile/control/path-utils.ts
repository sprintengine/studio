import { resolve } from 'path'

import { isPathInsideOrEqual } from '../../path-containment'

/** Re-exported: this module was the entry point its importers already had. */
export { isPathInsideOrEqual }

export function uniqueResolved(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))]
}
