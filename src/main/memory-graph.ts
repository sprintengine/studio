import { readdir, readFile, stat } from 'fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'path'

export type MemoryGraphNodeKind = 'markdown' | 'image' | 'text' | 'asset'

export type MemoryGraphNode = {
  id: string
  path: string
  relativePath: string
  name: string
  kind: MemoryGraphNodeKind
  extension: string
  sizeBytes: number
  degree: number
  group: string
}

export type MemoryGraphEdge = {
  id: string
  source: string
  target: string
  sourcePath: string
  targetPath: string
}

export type MemoryUnresolvedLink = {
  sourcePath: string
  href: string
  resolvedRelativePath: string | null
  reason: 'missing' | 'outside-root'
}

export type MemoryRootStatus =
  | { ok: true; rootPath: string; relativeRoot: string }
  | {
      ok: false
      status: 'missing-workspace' | 'invalid-relative-path' | 'missing-memory-root' | 'inaccessible'
      relativeRoot: string | null
      message: string
    }

export type MemoryGraphIndexResult =
  | {
      ok: true
      rootPath: string
      relativeRoot: string
      nodes: MemoryGraphNode[]
      edges: MemoryGraphEdge[]
      groups: string[]
      unresolvedLinks: MemoryUnresolvedLink[]
      indexedAt: number
    }
  | MemoryRootStatus

export type MemoryPreviewResult =
  | { ok: true; node: MemoryGraphNode; previewKind: 'markdown' | 'text'; content: string }
  | { ok: true; node: MemoryGraphNode; previewKind: 'image'; dataUrl: string }
  | { ok: true; node: MemoryGraphNode; previewKind: 'unsupported'; message: string }
  | { ok: false; message: string }

const IMAGE_EXTENSIONS = new Set(['.apng', '.avif', '.bmp', '.gif', '.ico', '.jpg', '.jpeg', '.png', '.svg', '.webp'])
const TEXT_EXTENSIONS = new Set([
  '.css',
  '.csv',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdx',
  '.scss',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
])
const MARKDOWN_LINK_RE = /!?\[[^\]]*]\(([^)]+)\)/g
const MAX_INDEX_FILES = 5000
const MAX_MARKDOWN_BYTES = 1024 * 1024

type FileEntry = {
  path: string
  relativePath: string
  name: string
  extension: string
  sizeBytes: number
}

export function normalizeMemoryRelativeRoot(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/u, '')
  if (!normalized || normalized === '.' || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return null
  return normalized
}

function normalizePathKey(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

function toDisplayRelativePath(rootPath: string, filePath: string): string {
  return relative(rootPath, filePath).split(sep).join('/')
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const parentKey = normalizePathKey(resolve(parentPath))
  const childKey = normalizePathKey(resolve(childPath))
  return childKey === parentKey || childKey.startsWith(`${parentKey}/`)
}

function classifyNode(extension: string): MemoryGraphNodeKind {
  if (extension === '.md' || extension === '.mdx') return 'markdown'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  return 'asset'
}

function groupForRelativePath(relativePath: string): string {
  const first = relativePath.split('/').filter(Boolean)[0]
  return first && relativePath.includes('/') ? first : 'Root'
}

async function collectFiles(rootPath: string): Promise<FileEntry[]> {
  const files: FileEntry[] = []

  const visit = async (dirPath: string) => {
    if (files.length >= MAX_INDEX_FILES) return
    const entries = await readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.obsidian') continue
      const entryPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath)
        continue
      }
      if (!entry.isFile()) continue

      const stats = await stat(entryPath)
      const extension = extname(entry.name).toLowerCase()
      files.push({
        path: entryPath,
        relativePath: toDisplayRelativePath(rootPath, entryPath),
        name: entry.name,
        extension,
        sizeBytes: stats.size,
      })
      if (files.length >= MAX_INDEX_FILES) return
    }
  }

  await visit(rootPath)
  return files
}

export async function resolveMemoryRoot(
  workspaceRoot: string | null | undefined,
  relativeRootInput: string | null | undefined
): Promise<MemoryRootStatus> {
  const relativeRoot = normalizeMemoryRelativeRoot(relativeRootInput)
  if (!workspaceRoot?.trim()) {
    return {
      ok: false,
      status: 'missing-workspace',
      relativeRoot,
      message: 'Open a workspace folder before configuring memory.',
    }
  }
  if (!relativeRoot) {
    return {
      ok: false,
      status: 'invalid-relative-path',
      relativeRoot: null,
      message: 'Memory path must be a non-empty relative path.',
    }
  }

  const rootPath = resolve(workspaceRoot, relativeRoot)
  try {
    const stats = await stat(rootPath)
    if (!stats.isDirectory()) {
      return {
        ok: false,
        status: 'missing-memory-root',
        relativeRoot,
        message: 'Configured memory path is not a folder.',
      }
    }
  } catch (error) {
    return {
      ok: false,
      status: 'missing-memory-root',
      relativeRoot,
      message: error instanceof Error ? error.message : 'Configured memory folder is missing.',
    }
  }

  return { ok: true, rootPath, relativeRoot }
}

function parseMarkdownLinks(content: string): string[] {
  const links: string[] = []
  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    const raw = match[1]?.trim()
    if (!raw) continue
    const href = raw.split(/\s+["'][^"']*["']\s*$/u)[0]?.trim() ?? raw
    links.push(href)
  }
  return links
}

function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')
}

function stripHrefDecoration(href: string): string {
  const withoutAnchor = href.split('#')[0] ?? href
  const withoutQuery = withoutAnchor.split('?')[0] ?? withoutAnchor
  try {
    return decodeURIComponent(withoutQuery)
  } catch {
    return withoutQuery
  }
}

export async function indexMemoryGraph(
  workspaceRoot: string | null | undefined,
  relativeRootInput: string | null | undefined
): Promise<MemoryGraphIndexResult> {
  const root = await resolveMemoryRoot(workspaceRoot, relativeRootInput)
  if (!root.ok) return root

  try {
    const files = await collectFiles(root.rootPath)
    const nodeByRelativePath = new Map<string, MemoryGraphNode>()
    const keyByRelativePath = new Map<string, string>()

    files.forEach((file) => {
      const node: MemoryGraphNode = {
        id: file.relativePath,
        path: file.path,
        relativePath: file.relativePath,
        name: file.name,
        kind: classifyNode(file.extension),
        extension: file.extension,
        sizeBytes: file.sizeBytes,
        degree: 0,
        group: groupForRelativePath(file.relativePath),
      }
      nodeByRelativePath.set(file.relativePath, node)
      keyByRelativePath.set(normalizePathKey(file.relativePath), file.relativePath)
    })

    const edges: MemoryGraphEdge[] = []
    const edgeKeys = new Set<string>()
    const unresolvedLinks: MemoryUnresolvedLink[] = []

    for (const file of files) {
      if (file.extension !== '.md' && file.extension !== '.mdx') continue
      if (file.sizeBytes > MAX_MARKDOWN_BYTES) continue

      const content = await readFile(file.path, 'utf-8')
      for (const href of parseMarkdownLinks(content)) {
        if (isExternalHref(href)) continue
        const cleanHref = stripHrefDecoration(href)
        if (!cleanHref) continue

        const targetPath = resolve(join(root.rootPath, file.relativePath, '..'), cleanHref)
        if (!isPathInside(root.rootPath, targetPath)) {
          unresolvedLinks.push({
            sourcePath: file.relativePath,
            href,
            resolvedRelativePath: null,
            reason: 'outside-root',
          })
          continue
        }

        const targetRelativePath = toDisplayRelativePath(root.rootPath, targetPath)
        const targetKey = keyByRelativePath.get(normalizePathKey(targetRelativePath))
        if (!targetKey) {
          unresolvedLinks.push({
            sourcePath: file.relativePath,
            href,
            resolvedRelativePath: targetRelativePath,
            reason: 'missing',
          })
          continue
        }

        const edgeKey = `${file.relativePath}\u001f${targetKey}`
        if (file.relativePath === targetKey || edgeKeys.has(edgeKey)) continue
        edgeKeys.add(edgeKey)
        edges.push({
          id: `${file.relativePath}->${targetKey}`,
          source: file.relativePath,
          target: targetKey,
          sourcePath: file.relativePath,
          targetPath: targetKey,
        })
      }
    }

    edges.forEach((edge) => {
      const source = nodeByRelativePath.get(edge.source)
      const target = nodeByRelativePath.get(edge.target)
      if (source) source.degree += 1
      if (target) target.degree += 1
    })

    const nodes = [...nodeByRelativePath.values()]
    const groups = [...new Set(nodes.map((node) => node.group))].sort()

    return {
      ok: true,
      rootPath: root.rootPath,
      relativeRoot: root.relativeRoot,
      nodes,
      edges,
      groups,
      unresolvedLinks,
      indexedAt: Date.now(),
    }
  } catch (error) {
    return {
      ok: false,
      status: 'inaccessible',
      relativeRoot: root.relativeRoot,
      message: error instanceof Error ? error.message : 'Unable to index memory folder.',
    }
  }
}

function imageMimeType(filePath: string): string | null {
  switch (extname(filePath).toLowerCase()) {
    case '.apng':
      return 'image/apng'
    case '.avif':
      return 'image/avif'
    case '.bmp':
      return 'image/bmp'
    case '.gif':
      return 'image/gif'
    case '.ico':
      return 'image/x-icon'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.svg':
      return 'image/svg+xml'
    case '.webp':
      return 'image/webp'
    default:
      return null
  }
}

export async function readMemoryPreview(
  workspaceRoot: string | null | undefined,
  relativeRootInput: string | null | undefined,
  relativePathInput: string
): Promise<MemoryPreviewResult> {
  const root = await resolveMemoryRoot(workspaceRoot, relativeRootInput)
  if (!root.ok) return { ok: false, message: root.message }

  const relativePath = relativePathInput.replace(/\\/g, '/').replace(/^\/+/u, '')
  const filePath = resolve(root.rootPath, relativePath)
  if (!isPathInside(root.rootPath, filePath)) {
    return { ok: false, message: 'Memory preview path is outside the memory root.' }
  }

  try {
    const stats = await stat(filePath)
    if (!stats.isFile()) return { ok: false, message: 'Memory preview target is not a file.' }
    const extension = extname(filePath).toLowerCase()
    const node: MemoryGraphNode = {
      id: relativePath,
      path: filePath,
      relativePath,
      name: relativePath.split('/').filter(Boolean).pop() ?? relativePath,
      kind: classifyNode(extension),
      extension,
      sizeBytes: stats.size,
      degree: 0,
      group: groupForRelativePath(relativePath),
    }

    if (node.kind === 'image') {
      const mimeType = imageMimeType(filePath)
      if (!mimeType) return { ok: true, node, previewKind: 'unsupported', message: 'Image type is not supported.' }
      const content = await readFile(filePath)
      return { ok: true, node, previewKind: 'image', dataUrl: `data:${mimeType};base64,${content.toString('base64')}` }
    }

    if (node.kind === 'markdown' || node.kind === 'text') {
      if (stats.size > MAX_MARKDOWN_BYTES) {
        return { ok: true, node, previewKind: 'unsupported', message: 'File is too large to preview.' }
      }
      const content = await readFile(filePath, 'utf-8')
      return { ok: true, node, previewKind: node.kind === 'markdown' ? 'markdown' : 'text', content }
    }

    return { ok: true, node, previewKind: 'unsupported', message: 'Preview is not available for this file type.' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Unable to read memory preview.' }
  }
}
