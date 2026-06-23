/**
 * Pure helpers for the unified "Folder" field on the New Workspace step: slug
 * suggestion, folder-name validation, smart default location, and full-path
 * analysis. Kept separate from the component so this logic is unit-testable
 * without rendering.
 */
import { basename, isAbsoluteFilePath, parentPath, pathJoin } from '../../../utils/paths'

const DEFAULT_NEW_FOLDER_NAME = 'new-workspace'

// Characters that are illegal in folder names across macOS/Windows. Control
// characters are checked numerically (code point <= 0x1f) to keep this source
// free of literal control bytes.
const ILLEGAL_PRINTABLE_CHARS = /[<>:"|?*]/u
const MAX_CONTROL_CHAR_CODE = 0x1f

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) <= MAX_CONTROL_CHAR_CODE) return true
  }
  return false
}

/** Slugified folder name derived from the workspace name, with a safe fallback. */
export function suggestedWorkspaceFolderName(workspaceName: string): string {
  const slug = workspaceName
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return slug || DEFAULT_NEW_FOLDER_NAME
}

/** Returns a user-facing error string for an invalid folder name, or null if valid. */
export function validateWorkspaceFolderName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[/\\]/.test(trimmed)) {
    return 'Enter a valid folder name.'
  }
  if (hasControlChar(trimmed) || ILLEGAL_PRINTABLE_CHARS.test(trimmed)) {
    return 'Folder names cannot contain control characters or <>:"|?*.'
  }
  if (/[. ]$/u.test(trimmed)) {
    return 'Folder names cannot end with a period or space.'
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(trimmed)) {
    return 'That folder name is reserved by Windows.'
  }
  return null
}

/**
 * Smart default location for a new workspace folder, so the user usually never
 * has to browse. Prefers a sibling of the already-selected folder, then a
 * sibling of the most-recent folder, then a cold-start fallback (e.g. the OS
 * Documents directory). Returns null only when nothing is known yet, in which
 * case the user must Browse.
 */
export function resolveDefaultParentPath({
  folderPath,
  recentFolders,
  fallbackParent = null,
}: {
  folderPath: string | null
  recentFolders: readonly string[]
  fallbackParent?: string | null
}): string | null {
  if (folderPath?.trim()) return parentPath(folderPath)
  const mostRecent = recentFolders.find((entry) => entry?.trim())
  if (mostRecent) return parentPath(mostRecent)
  if (fallbackParent?.trim()) return fallbackParent.trim()
  return null
}

/**
 * Proposed default full path for the unified folder field: the smart parent
 * joined with the slug of the workspace name. Null when no parent is known yet.
 */
export function defaultWorkspaceFolderPath(
  parentDir: string | null,
  workspaceName: string,
): string | null {
  if (!parentDir?.trim()) return null
  return pathJoin(parentDir, suggestedWorkspaceFolderName(workspaceName))
}

export type WorkspaceTargetAnalysis =
  | { ok: true; parent: string; leaf: string; error: null }
  | { ok: false; parent: string | null; leaf: string | null; error: string }

/**
 * Structural validation of the unified folder field's full path, independent of
 * whether it exists on disk (existence is checked asynchronously by the caller).
 * A path is structurally valid when it is absolute and decomposes into a parent
 * directory plus a leaf folder name that passes folder-name validation — which
 * is exactly what create-if-missing needs. An already-existing folder at this
 * path is handled as "open" by the caller regardless of leaf naming, so callers
 * should treat existence as overriding a leaf-name error.
 */
export function analyzeWorkspaceTargetPath(rawPath: string): WorkspaceTargetAnalysis {
  const trimmed = rawPath.trim()
  if (!trimmed) {
    return { ok: false, parent: null, leaf: null, error: 'Choose a folder for the workspace.' }
  }
  if (!isAbsoluteFilePath(trimmed)) {
    return { ok: false, parent: null, leaf: null, error: 'Enter an absolute folder path.' }
  }
  const parent = parentPath(trimmed)
  const leaf = basename(trimmed)
  if (!leaf || parent === trimmed) {
    return { ok: false, parent: null, leaf: null, error: 'Enter a folder path with a name.' }
  }
  const leafError = validateWorkspaceFolderName(leaf)
  if (leafError) {
    return { ok: false, parent, leaf, error: leafError }
  }
  return { ok: true, parent, leaf, error: null }
}
