import type { SprintEngineSourcePlanKind } from '../../../types/workspace'
import { basename } from '../../../utils/paths'

export { basename }

export function folderKey(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase() || path
}

export function toTitleName(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

export function pathSeparatorFor(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

export function joinPath(parent: string, child: string): string {
  const separator = pathSeparatorFor(parent)
  return `${parent}${parent.endsWith(separator) ? '' : separator}${child}`
}

export function workspaceRelativePath(rootPath: string, filePath: string): string | null {
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedFile = filePath.replace(/\\/g, '/')
  const rootKey = normalizedRoot.toLowerCase()
  const fileKey = normalizedFile.toLowerCase()
  if (fileKey === rootKey || !fileKey.startsWith(`${rootKey}/`)) return null
  return normalizedFile.slice(normalizedRoot.length + 1)
}

export function planBasename(path: string): string {
  const name = basename(path)
  return name.replace(/\.md$/i, '')
}

export function markdownTitle(content: string): string | null {
  const heading = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#(?!#)\s+\S/.test(line))

  return heading?.replace(/^#\s+/, '').trim() || null
}

export function shouldScanDirectory(name: string): boolean {
  return name !== 'node_modules' && name !== '.git' && name !== '.multicode-worktrees'
}

/**
 * A sibling project's folder name reduced to the handle a run can declare it under
 * (MC-1613). MIRRORS `SIBLING_REPO_ID_PATTERN` in sprintengine_core/tool/shell.py
 * (`^[a-z0-9][a-z0-9._-]*$`): the engine is the authority and rejects anything else
 * with a plain-language reason, so this only has to stop offering a project whose
 * name cannot produce a legal handle at all.
 *
 * Returns '' when nothing usable survives (e.g. a folder named `---`), which the
 * caller treats as "not offerable".
 */
export function slugifySiblingProjectId(folderName: string): string {
  return folderName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-.]+$/, '')
}

const PRODUCT_FILENAME = /(^|[-_/\s])(product|prd|requirements|spec|rfc|brief)([-_\s.]|$)/i
const ARCHITECT_FILENAME = /(^|[-_/\s])(implementation|architect|architecture|engineering|technical|tech[-_\s]?spec)([-_\s.]|$)/i
const GENERIC_PLAN_FILENAME = /(^|[-_/\s])plan([-_\s.]|$)/i
const ARCHITECT_TITLE = /\b(implementation plan|architect plan|technical plan|engineering plan|tech spec)\b/i
const PRODUCT_TITLE = /\b(product plan|product requirements|prd|product brief)\b/i

export function inferSourcePlanKind(filename: string, content: string): SprintEngineSourcePlanKind {
  const baseName = basename(filename).replace(/\.md$/i, '')
  if (ARCHITECT_FILENAME.test(baseName)) return 'architect_plan'
  if (PRODUCT_FILENAME.test(baseName)) return 'product_plan'

  const title = markdownTitle(content) ?? ''
  if (PRODUCT_TITLE.test(title)) return 'product_plan'
  if (ARCHITECT_TITLE.test(title)) return 'architect_plan'
  if (GENERIC_PLAN_FILENAME.test(baseName)) return 'unknown'

  return 'unknown'
}
