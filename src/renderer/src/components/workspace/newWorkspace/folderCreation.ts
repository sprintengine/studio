/**
 * Pure helpers for choosing a new workspace folder: slug suggestion and smart
 * default location. Kept separate from the components so this logic is
 * unit-testable without rendering.
 */
import { parentPath } from '../../../utils/paths'

const DEFAULT_NEW_FOLDER_NAME = 'new-workspace'

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
