import type { SprintEngineSourcePlanKind } from '../../../types/workspace'

export function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

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

const PRODUCT_FILENAME = /(^|[-_/\s])(product|prd|requirements|spec|rfc|brief)([-_\s.]|$)/i
const ARCHITECT_FILENAME = /(^|[-_/\s])(implementation|architect|engineering|technical|tech[-_\s]?spec)([-_\s.]|$)/i
const GENERIC_PLAN_FILENAME = /(^|[-_/\s])plan([-_\s.]|$)/i
const ARCHITECT_TITLE = /\b(implementation plan|architect plan|technical plan|engineering plan|tech spec)\b/i
const PRODUCT_TITLE = /\b(product plan|product requirements|prd|product brief)\b/i

export function inferSourcePlanKind(filename: string, content: string): SprintEngineSourcePlanKind {
  const baseName = basename(filename).replace(/\.md$/i, '')
  if (PRODUCT_FILENAME.test(baseName)) return 'product_plan'
  if (ARCHITECT_FILENAME.test(baseName)) return 'architect_plan'

  const title = markdownTitle(content) ?? ''
  if (PRODUCT_TITLE.test(title)) return 'product_plan'
  if (ARCHITECT_TITLE.test(title)) return 'architect_plan'
  if (GENERIC_PLAN_FILENAME.test(baseName)) return 'unknown'

  return 'unknown'
}
