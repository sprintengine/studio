import { isAbsolute, relative, resolve } from 'node:path'

// Shared safety rules for serving third-party entry code. Every entry bundle
// (entry.main, entry.renderer) must resolve strictly inside its module root —
// `..` traversal, absolute paths, and NUL bytes are rejected — and any message
// that might reach the renderer must not leak absolute filesystem paths.

export function resolveContainedEntry(
  moduleRoot: string,
  entryRelative: string,
  field: 'entry.main' | 'entry.renderer'
): string {
  return resolveContainedPath(moduleRoot, entryRelative, field)
}

/**
 * The containment rule itself: `candidate` resolved against `moduleRoot` must
 * name something strictly inside it. Shared by the entry bundles and by the
 * skill directories a module registers — a module pointing `sourceDir` at
 * `../../.ssh` is the same escape as an entry doing it.
 */
export function resolveContainedPath(moduleRoot: string, candidate: string, field: string): string {
  const root = resolve(moduleRoot)
  const resolved = resolve(root, candidate)
  const rootRelative = relative(root, resolved)
  if (
    rootRelative.length === 0 ||
    rootRelative.startsWith('..') ||
    rootRelative.includes('\0') ||
    resolve(root, rootRelative) !== resolved
  ) {
    throw new Error(`${field} must resolve inside the module root.`)
  }
  return resolved
}

/**
 * Where a module's registered skill directory really is. A third-party module
 * has a root on disk, so `sourceDir` is relative to it and must stay inside
 * it. A bundled module has no root of its own — its code is the app's — so it
 * passes an absolute path, which is the only thing there is to resolve.
 */
export function resolveModuleSkillDirectory(
  moduleRoot: string | null | undefined,
  sourceDir: string,
  field = 'skill sourceDir'
): string {
  if (!sourceDir || sourceDir.includes('\0')) {
    throw new Error(`${field} must be a non-empty path.`)
  }
  if (!moduleRoot) {
    if (!isAbsolute(sourceDir)) {
      throw new Error(`${field} must be an absolute path for a module with no module root.`)
    }
    return resolve(sourceDir)
  }
  return resolveContainedPath(moduleRoot, sourceDir, field)
}

// The message-sanitation half lives in shared code (the renderer-side loader
// applies the same rule to its own load errors); re-exported here so main-side
// callers keep one import for both containment rules.
export { sanitizeEntryMessage } from '../../shared/modules/entry-messages'
