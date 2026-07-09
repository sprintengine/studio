import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { getGitEntry, normalizePathKey, useGitStatus } from '../../hooks/useGitStatus'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { getGitStatusAppearance } from '../../utils/gitStatusAppearance'
import { focusOrAddFileTab, remapFileTabsForPath, removeFileTabsForPath } from '../../utils/modelRegistry'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { isImageFile } from '../../utils/files'
import { openDiffWindow } from '../auxWindows/openDiffWindow'
import { openFileSurface } from '../../utils/openFileSurface'
import { fileExplorerSelectionFromVerticalRange, fileExplorerSelectionRange } from '../../utils/fileExplorerSelection'
import { slugifySprintEngineName } from '../../utils/sprintengineStateFile'
import { setFileDropData } from '../../utils/terminalDrop'
import { IconButton } from '../ui/Buttons'
import { PanelHeader } from '../ui/PanelHeader'
import { InboxSearchInput } from '../ui/InboxSearchInput'
import { Skeleton } from '../ui/Skeleton'
import { Tooltip } from '../ui/Tooltip'
import { Toast } from '../ui/Toast'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { inferSourcePlanKind } from '../workspace/newWorkspace/helpers'
import type { FuturePlanWorkspaceSource, SprintEngineSourceBundleItem, SprintEngineSourcePlanKind } from '../../types/workspace'

const EMPTY_SEARCH_EXCLUDES: string[] = []
const EMPTY_EXPANDED_PATHS: string[] = []

type Entry = {
  name: string
  isDir: boolean
  path: string
  parentPath: string
  gitDeleted?: boolean
}

type TreeRow = {
  entry: Entry
  depth: number
}

type ExplorerClipboard = {
  path: string
  isDir: boolean
}

type RenameDraft = {
  entry: Entry
  value: string
}

type CreateEntryRequest = {
  kind: 'file' | 'dir'
  token: number
}

const MULTICODE_EXPLORER_MOVE_MIME = 'application/x-multicode-explorer-move'

type ExplorerMovePayload = {
  version: 1
  workspaceId: string
  rootPath: string
  entries: Entry[]
}

function toEntries(raw: { name: string; isDir: boolean }[], parent: string): Entry[] {
  const joiner = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return raw
    .map((entry) => ({
      ...entry,
      path: `${parent}${parent.endsWith(joiner) ? '' : joiner}${entry.name}`,
      parentPath: parent,
    }))
    .filter((entry) => entry.name !== 'node_modules')
    .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
}

function isIgnoredExplorerWatchPath(path: string | null): boolean {
  if (!path) return false

  return path
    .split(/[/\\]+/)
    .filter(Boolean)
    .some((segment) => segment === 'node_modules')
}

function flattenTree(
  entries: Entry[],
  depth: number,
  expanded: Record<string, boolean>,
  childrenByPath: Record<string, Entry[]>
): TreeRow[] {
  const rows: TreeRow[] = []

  for (const entry of entries) {
    rows.push({ entry, depth })
    if (entry.isDir && expanded[entry.path]) {
      rows.push(...flattenTree(childrenByPath[entry.path] ?? [], depth + 1, expanded, childrenByPath))
    }
  }

  return rows
}

type SearchTreeNode = {
  entry: Entry
  children: Map<string, SearchTreeNode>
}

type FileSearchDiagnostics = {
  engine: 'ripgrep'
  elapsedMs: number
  resultCount: number
  truncated: boolean
}

type FileSearchResponse = {
  entries: Entry[]
  diagnostics: FileSearchDiagnostics | null
}

type RefreshTreeCause = 'initial' | 'watch' | 'manual' | 'git-status' | 'reveal'

function buildSearchTreeRows(rootPath: string, entries: Entry[]): TreeRow[] {
  const separator = pathSeparatorFor(rootPath)
  const rootChildren = new Map<string, SearchTreeNode>()

  const getOrCreateDirectory = (
    children: Map<string, SearchTreeNode>,
    name: string,
    parentPath: string
  ): SearchTreeNode => {
    const path = `${parentPath}${parentPath.endsWith(separator) ? '' : separator}${name}`
    const existing = children.get(path)
    if (existing) return existing

    const node: SearchTreeNode = {
      entry: {
        name,
        isDir: true,
        path,
        parentPath,
      },
      children: new Map(),
    }
    children.set(path, node)
    return node
  }

  entries.forEach((entry) => {
    const relativePath = workspaceRelativePath(rootPath, entry.path)
    if (!relativePath) {
      rootChildren.set(entry.path, { entry, children: new Map() })
      return
    }

    const segments = relativePath.split('/').filter(Boolean)
    if (segments.length <= 1) {
      rootChildren.set(entry.path, { entry, children: new Map() })
      return
    }

    let parentPath = rootPath
    let currentChildren = rootChildren
    segments.slice(0, -1).forEach((segment) => {
      const directory = getOrCreateDirectory(currentChildren, segment, parentPath)
      parentPath = directory.entry.path
      currentChildren = directory.children
    })
    currentChildren.set(entry.path, { entry: { ...entry, parentPath }, children: new Map() })
  })

  const rows: TreeRow[] = []
  const visit = (nodes: SearchTreeNode[], depth: number) => {
    nodes
      .sort((a, b) => {
        if (a.entry.isDir !== b.entry.isDir) return a.entry.isDir ? -1 : 1
        return a.entry.name.localeCompare(b.entry.name)
      })
      .forEach((node) => {
        rows.push({ entry: node.entry, depth })
        if (node.entry.isDir) visit([...node.children.values()], depth + 1)
      })
  }

  visit([...rootChildren.values()], 0)
  return rows
}

// File-type chip — language identity carried by an accent hue plus a two-letter
// label. Background and border are derived from the accent at render time via
// color-mix(), so the chip tints the current --bg-surface toward the language
// color. On dark surfaces the chip lands as a dark wash of the hue; on light
// surfaces as a soft pastel. Chrome around the chip (row hover, selection)
// uses semantic tokens elsewhere in this file.
// design-tokens-allow-block: language-identity accent palette (TS blue, PY green, etc.)
function fileAppearance(name: string): { accent: string; label: string } {
  if (name === 'package.json') return { accent: '#f2c45f', label: '{}' }
  const ext = name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return { accent: '#7db3ff', label: 'TS' }
    case 'js':
    case 'jsx':
      return { accent: '#f2d36b', label: 'JS' }
    case 'java':
      return { accent: '#f19974', label: 'JV' }
    case 'py':
      return { accent: '#84d69b', label: 'PY' }
    case 'rs':
      return { accent: '#f19974', label: 'RS' }
    case 'go':
      return { accent: '#7bd7ea', label: 'GO' }
    case 'json':
      return { accent: '#f2c45f', label: '{}' }
    case 'yaml':
    case 'yml':
      return { accent: '#f2c45f', label: 'YML' }
    case 'md':
      return { accent: '#cfd2dd', label: 'MD' }
    case 'txt':
      return { accent: '#b9bcc8', label: 'TXT' }
    case 'html':
      return { accent: '#ff9f75', label: '<>' }
    case 'css':
    case 'scss':
      return { accent: '#7db3ff', label: '#' }
    case 'sh':
    case 'bash':
      return { accent: '#84d69b', label: 'SH' }
    default:
      return { accent: '#a6abb8', label: '.' }
  }
}
// design-tokens-allow-end

function FileIcon({ name }: { name: string }) {
  const { accent, label } = fileAppearance(name)
  // color-mix tints the current theme surface toward the language hue, so the
  // chip lands native on every theme without a per-theme palette table.
  const bg = `color-mix(in oklab, var(--bg-surface) 84%, ${accent})`
  const border = `color-mix(in oklab, var(--bg-surface) 55%, ${accent})`
  // On dark --file-badge-ink-mix is 0% so the label is the pure language hue;
  // on Light it rises to ~50% so the hue is pulled toward ink and stays legible
  // on the near-white chip instead of washing out (amber was ~1.6:1).
  const ink = `color-mix(in oklab, ${accent}, var(--text-strong) var(--file-badge-ink-mix, 0%))`
  return (
    <span
      className="inline-flex h-[18px] w-[20px] shrink-0 items-center justify-center rounded-[4px] border font-mono text-[8px] font-black leading-none ring-1 ring-[color:var(--border-subtle)]"
      style={{ color: ink, backgroundColor: bg, borderColor: border }}
    >
      {label}
    </span>
  )
}

function ChevronIcon({ expanded, onClick }: { expanded: boolean; onClick?: React.MouseEventHandler<HTMLButtonElement> }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={onClick}
      className="inline-flex h-[18px] w-3 shrink-0 items-center justify-center text-[color:var(--text-muted)] transition-colors group-hover:text-[color:var(--text-default)]"
      aria-label={expanded ? 'Collapse folder' : 'Expand folder'}
    >
      <svg
        viewBox="0 0 12 12"
        aria-hidden="true"
        className={`icon-xs transition-transform ${expanded ? 'rotate-90' : ''}`}
        fill="none"
      >
        <path d="M4.25 2.5 7.75 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

// design-tokens-allow: folder-glyph identity palette — the yellow folder icon
// is a brand-recognisable folder mark, not chrome. Chrome around it (row hover,
// selection) uses semantic tokens.
function FolderIcon({ expanded }: { expanded: boolean }) {
  return (
    <span className="inline-flex h-[20px] w-[22px] shrink-0 items-center justify-center">
      <svg viewBox="0 0 24 20" aria-hidden="true" className="h-5 w-6">
        <path
          d="M2.5 5.8c0-1.1.9-2 2-2h5.1l1.9 2.1h8c1.1 0 2 .9 2 2v.95h-19V5.8Z"
          // design-tokens-allow: folder-glyph palette
          fill={expanded ? '#ffe18a' : '#f2c45f'}
          // design-tokens-allow: folder-glyph palette
          stroke="#7a5b18"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path
          d="M2.25 8.4h19.5l-1.45 7.25c-.22 1.06-1.15 1.85-2.23 1.85H5.93c-1.08 0-2.01-.79-2.23-1.85L2.25 8.4Z"
          // design-tokens-allow: folder-glyph palette
          fill={expanded ? '#f4b94f' : '#d9992f'}
          // design-tokens-allow: folder-glyph palette
          stroke="#7a5b18"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        {/* design-tokens-allow: folder-glyph palette */}
        <path d="M5.5 10.35h13" stroke="#ffe7a5" strokeWidth="1.15" strokeLinecap="round" opacity="0.7" />
      </svg>
    </span>
  )
}

function RefreshFilesIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
      <path
        d="M13.25 7.25A5.25 5.25 0 0 0 4.05 4.1L2.75 5.5m0 0H6m-3.25 0V2.25M2.75 8.75a5.25 5.25 0 0 0 9.2 3.15l1.3-1.4m0 0H10m3.25 0v3.25"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function RevealActiveFileIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
      <circle cx="8" cy="8" r="4.75" stroke="currentColor" strokeWidth="1.35" />
      <circle cx="8" cy="8" r="1.45" fill="currentColor" />
      <path d="M8 1.75v2M8 12.25v2M14.25 8h-2M3.75 8h-2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  )
}

function NewFileIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
      <path
        d="M4.25 1.75h5.4l2.1 2.1v10.4h-7.5a1.5 1.5 0 0 1-1.5-1.5v-9.5a1.5 1.5 0 0 1 1.5-1.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M9.5 1.9v2.25h2.25M5.5 8h4M7.5 6v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function NewFolderIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="icon-sm" fill="none">
      <path
        d="M1.75 4.7c0-.8.65-1.45 1.45-1.45h3.05l1.2 1.45h5.35c.8 0 1.45.65 1.45 1.45v6.15c0 .8-.65 1.45-1.45 1.45H3.2c-.8 0-1.45-.65-1.45-1.45V4.7Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M6 9h4M8 7v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function remapPath(path: string, fromPath: string, toPath: string): string {
  if (path === fromPath) return toPath
  const separator = fromPath.includes('\\') && !fromPath.includes('/') ? '\\' : '/'
  const prefix = `${fromPath}${separator}`
  return path.startsWith(prefix) ? `${toPath}${path.slice(fromPath.length)}` : path
}

function isPathOrChild(path: string, parentPath: string): boolean {
  if (path === parentPath) return true
  const separator = parentPath.includes('\\') && !parentPath.includes('/') ? '\\' : '/'
  return path.startsWith(`${parentPath}${separator}`)
}

function topLevelEntries(entries: Entry[]): Entry[] {
  return entries.filter(
    (entry) => !entries.some((candidate) => candidate.path !== entry.path && isPathOrChild(entry.path, candidate.path))
  )
}

function pathSeparatorFor(path: string): '\\' | '/' {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

function parseExplorerMovePayload(dataTransfer: DataTransfer): ExplorerMovePayload | null {
  const raw = dataTransfer.getData(MULTICODE_EXPLORER_MOVE_MIME)
  if (!raw) return null

  try {
    const value = JSON.parse(raw) as Partial<ExplorerMovePayload>
    if (value.version !== 1 || typeof value.workspaceId !== 'string' || typeof value.rootPath !== 'string') {
      return null
    }
    if (!Array.isArray(value.entries)) return null

    const entries = value.entries.filter((entry): entry is Entry => (
      Boolean(entry)
      && typeof entry.name === 'string'
      && typeof entry.path === 'string'
      && typeof entry.parentPath === 'string'
      && typeof entry.isDir === 'boolean'
      && entry.path.trim().length > 0
    ))
    if (!entries.length) return null

    return {
      version: 1,
      workspaceId: value.workspaceId,
      rootPath: value.rootPath,
      entries,
    }
  } catch {
    return null
  }
}

function hasExplorerMovePayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(MULTICODE_EXPLORER_MOVE_MIME)
}

// True for OS-level file drags (Finder, desktop, browser). The browser only adds
// the read-only `Files` type for native drags, so this never matches an in-app
// explorer move, which carries MULTICODE_EXPLORER_MOVE_MIME instead.
function hasNativeFileDrop(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}

// `dataTransfer.files` is only populated on drop, not during dragover. Resolve
// each entry to a real disk path via Electron's getPathForFile bridge.
function collectNativeDropPaths(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.files)
    .map((file) => {
      const path = window.api.getPathForFile(file) || (file as File & { path?: unknown }).path
      return typeof path === 'string' && path.trim() ? path : null
    })
    .filter((path): path is string => Boolean(path))
}

function parentDirectoriesForPath(rootPath: string, filePath: string): string[] {
  if (!isPathOrChild(filePath, rootPath) || filePath === rootPath) return []

  const separator = pathSeparatorFor(rootPath)
  const relativePath = filePath.slice(rootPath.length + separator.length)
  const segments = relativePath.split(separator).filter(Boolean)
  const parentSegments = segments.slice(0, -1)

  return parentSegments.reduce<string[]>((directories, segment) => {
    const parent = directories.at(-1) ?? rootPath
    directories.push(`${parent}${separator}${segment}`)
    return directories
  }, [])
}

function relativeChildPath(parentPath: string, childPath: string): string | null {
  const normalizedParent = normalizePathKey(parentPath)
  const normalizedChild = normalizePathKey(childPath)
  if (normalizedChild === normalizedParent || !normalizedChild.startsWith(`${normalizedParent}/`)) return null
  const separator = pathSeparatorFor(parentPath)
  return childPath.slice(parentPath.length + separator.length)
}

function workspaceRelativePath(rootPath: string, filePath: string): string | null {
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedFile = filePath.replace(/\\/g, '/')
  const rootKey = normalizePathKey(normalizedRoot)
  const fileKey = normalizePathKey(normalizedFile)
  if (fileKey === rootKey || !fileKey.startsWith(`${rootKey}/`)) return null
  return normalizedFile.slice(normalizedRoot.length + 1)
}

function markdownSourceRelativePath(rootPath: string, entry: Entry): string | null {
  if (entry.isDir || entry.gitDeleted || !/\.md$/i.test(entry.name)) return null

  const relativePath = workspaceRelativePath(rootPath, entry.path)
  if (!relativePath) return null

  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
}

function sourceBundleRelativePath(rootPath: string, entry: Entry): string | null {
  if (entry.isDir || entry.gitDeleted || !/\.(md|html?)$/i.test(entry.name)) return null

  const relativePath = workspaceRelativePath(rootPath, entry.path)
  if (!relativePath) return null

  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized.startsWith('backlog/')) return null
  return normalized
}

function isHtmlFile(entry: Entry): boolean {
  return !entry.isDir && !entry.gitDeleted && /\.html?$/i.test(entry.name)
}

function isSourceBundleFile(rootPath: string, entry: Entry): boolean {
  return Boolean(sourceBundleRelativePath(rootPath, entry))
}

function isPotentialSourceBundleFile(entry: Entry): boolean {
  return !entry.isDir && !entry.gitDeleted && /\.(md|html?)$/i.test(entry.name)
}

function titleCasePlanName(value: string): string {
  return value
    .split(/[-_\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function markdownTitle(content: string): string | null {
  const heading = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#(?!#)\s+\S/.test(line))

  return heading?.replace(/^#\s+/, '').trim() || null
}

function planBasename(entryName: string): string {
  return entryName.replace(/\.md$/i, '')
}

function mergeGitDeletedEntries(entries: Entry[], dirPath: string, gitStatus: GitStatusSnapshot | null): Entry[] {
  if (!gitStatus) return entries

  const nextEntries = [...entries]
  const seen = new Set(entries.map((entry) => normalizePathKey(entry.path)))

  Object.values(gitStatus.files).forEach((status) => {
    if (status.status !== 'deleted') return

    const relativePath = relativeChildPath(dirPath, status.path)
    if (!relativePath) return

    const separatorMatch = relativePath.match(/[\\/]/)
    const childName = separatorMatch ? relativePath.slice(0, separatorMatch.index) : relativePath
    const childPath = `${dirPath}${pathSeparatorFor(dirPath)}${childName}`
    const key = normalizePathKey(childPath)
    if (seen.has(key)) return

    seen.add(key)
    nextEntries.push({
      name: childName,
      isDir: Boolean(separatorMatch),
      path: childPath,
      parentPath: dirPath,
      gitDeleted: true,
    })
  })

  return nextEntries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
}

function getDirectoryGitStatus(
  directoryStatus: Record<string, GitFileStatus>,
  dirPath: string
): GitFileStatus | null {
  return directoryStatus[normalizePathKey(dirPath)] ?? null
}

function getEntryGitStatus(
  gitStatus: GitStatusSnapshot | null,
  directoryStatus: Record<string, GitFileStatus>,
  entry: Entry
): GitFileStatus | null {
  if (entry.gitDeleted) return 'deleted'
  const exactStatus = getGitEntry(gitStatus, entry.path)?.status ?? null
  if (exactStatus) return exactStatus
  return entry.isDir ? getDirectoryGitStatus(directoryStatus, entry.path) : null
}

function remapChildrenByPath(
  childrenByPath: Record<string, Entry[]>,
  fromPath: string,
  toPath: string
): Record<string, Entry[]> {
  return Object.fromEntries(
    Object.entries(childrenByPath).map(([key, entries]) => [
      remapPath(key, fromPath, toPath),
      entries.map((entry) => ({
        ...entry,
        path: remapPath(entry.path, fromPath, toPath),
        parentPath: remapPath(entry.parentPath, fromPath, toPath),
      })),
    ])
  )
}

function remapExpandedPaths(
  expandedPaths: Record<string, boolean>,
  fromPath: string,
  toPath: string
): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(expandedPaths).map(([key, value]) => [remapPath(key, fromPath, toPath), value])
  )
}

function expandedPathRecordFromList(paths: string[], rootPath: string): Record<string, boolean> {
  const candidatePaths = new Set(paths.filter((path) => isPathOrChild(path, rootPath)))
  return Object.fromEntries(
    Array.from(candidatePaths)
      .filter((path) => parentDirectoriesForPath(rootPath, path).every((parentPath) => candidatePaths.has(parentPath)))
      .map((path) => [path, true])
  )
}

function expandedPathListFromRecord(expandedPaths: Record<string, boolean>): string[] {
  return Object.entries(expandedPaths)
    .filter(([, expanded]) => expanded)
    .map(([path]) => path)
}

async function searchFiles(
  rootPath: string,
  query: string,
  gitStatus: GitStatusSnapshot | null,
  searchExcludes: string[],
  limit = 200
): Promise<FileSearchResponse> {
  const lowerQuery = query.toLowerCase().trim()
  if (!lowerQuery) return { entries: [], diagnostics: null }

  const result = await window.api.searchFiles(rootPath, query, { limit, excludes: searchExcludes })
  if (!result.ok) throw new Error(result.message)

  const matches: Entry[] = result.results.map((entry) => ({ ...entry }))
  const seen = new Set(matches.map((entry) => normalizePathKey(entry.path)))

  Object.values(gitStatus?.files ?? {}).forEach((status) => {
    if (matches.length >= limit) return
    if (status.status !== 'deleted') return
    if (!isPathOrChild(status.path, rootPath)) return

    const name = status.path.split(/[/\\]/).filter(Boolean).pop()
    if (!name) return
    if (!name.toLowerCase().includes(lowerQuery) && !status.path.toLowerCase().includes(lowerQuery)) return

    const key = normalizePathKey(status.path)
    if (seen.has(key)) return
    seen.add(key)

    const separator = pathSeparatorFor(status.path)
    const parentPath = status.path.includes(separator)
      ? status.path.slice(0, status.path.lastIndexOf(separator))
      : rootPath
    matches.push({
      name,
      isDir: false,
      path: status.path,
      parentPath,
      gitDeleted: true,
    })
  })

  return {
    entries: matches,
    diagnostics: {
      engine: result.engine,
      elapsedMs: result.elapsedMs,
      resultCount: result.resultCount,
      truncated: result.truncated,
    },
  }
}

interface ExplorerTreeProps {
  workspaceId: string
  rootPath: string
  query: string
  searchExcludes: string[]
  refreshToken: number
  revealPath: string | null
  revealToken: number
  createRequest: CreateEntryRequest | null
  gitStatus: GitStatusSnapshot | null
  directoryStatus: Record<string, GitFileStatus>
  refreshGitStatus: () => Promise<void>
  onOpenFile: (path: string, name: string) => void
  onStartFuturePlan?: (source: FuturePlanWorkspaceSource) => void
}

function ExplorerTree({
  workspaceId,
  rootPath,
  query,
  searchExcludes,
  refreshToken,
  revealPath,
  revealToken,
  createRequest,
  gitStatus,
  directoryStatus,
  refreshGitStatus,
  onOpenFile,
  onStartFuturePlan,
}: ExplorerTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const openFile = useWorkspaceStore((s) => s.openFile)
  const remapOpenFiles = useWorkspaceStore((s) => s.remapOpenFiles)
  const removeOpenFilesForPath = useWorkspaceStore((s) => s.removeOpenFilesForPath)
  const setFileExplorerExpandedPaths = useWorkspaceStore((s) => s.setFileExplorerExpandedPaths)
  const setFileExplorerSelectedPath = useWorkspaceStore((s) => s.setFileExplorerSelectedPath)
  const dialog = useConfirmDialog()
  const readPersistedExpandedPaths = useCallback(() => (
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.fileExplorerState?.expandedPaths
    ?? EMPTY_EXPANDED_PATHS
  ), [workspaceId])
  const readPersistedSelectedPath = useCallback(() => (
    useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.fileExplorerState?.selectedPath
    ?? null
  ), [workspaceId])
  const initialExpandedPaths = useMemo(
    () => expandedPathRecordFromList(readPersistedExpandedPaths(), rootPath),
    [readPersistedExpandedPaths, rootPath]
  )

  const [rootEntries, setRootEntries] = useState<Entry[]>([])
  const [childrenByPath, setChildrenByPath] = useState<Record<string, Entry[]>>({})
  const [expandedPaths, setExpandedPathsState] = useState<Record<string, boolean>>(() => initialExpandedPaths)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set())
  const [clipboard, setClipboard] = useState<ExplorerClipboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<Entry[]>([])
  const [searchDiagnostics, setSearchDiagnostics] = useState<FileSearchDiagnostics | null>(null)
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null)
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null)
  const [rootDropActive, setRootDropActive] = useState(false)
  const [errorToast, setErrorToast] = useState<string | null>(null)
  const refreshTimeoutRef = useRef<number | null>(null)
  const searchTimeoutRef = useRef<number | null>(null)
  const searchRequestSeqRef = useRef(0)
  const committingRenameRef = useRef(false)
  const latestExpandedPathsRef = useRef<Record<string, boolean>>(initialExpandedPaths)
  const hasRestoredSelectionRef = useRef(false)
  const latestSearchQueryRef = useRef('')
  const latestSearchExcludesRef = useRef(searchExcludes)
  const latestGitStatusRef = useRef<GitStatusSnapshot | null>(gitStatus)
  const lastManualRefreshRef = useRef(refreshToken)
  const lastCreateRequestTokenRef = useRef(0)
  const selectionAnchorPathRef = useRef<string | null>(null)
  const activeRowsRef = useRef<TreeRow[]>([])
  const activeMoveDragRef = useRef<ExplorerMovePayload | null>(null)
  const dragSelectionRef = useRef<
    | { kind: 'background'; startY: number; active: boolean }
    | null
  >(null)
  const completedDragSelectionRef = useRef(false)

  const visibleRows = useMemo(
    () => flattenTree(rootEntries, 0, expandedPaths, childrenByPath),
    [rootEntries, expandedPaths, childrenByPath]
  )

  const isSearching = query.trim().length > 0
  const searchRows = useMemo(
    () => buildSearchTreeRows(rootPath, searchResults),
    [rootPath, searchResults]
  )
  const activeRows = isSearching
    ? searchRows
    : visibleRows
  const selectedEntries = useMemo(
    () => activeRows.filter((row) => selectedPaths.has(row.entry.path)).map((row) => row.entry),
    [activeRows, selectedPaths]
  )
  const searchDiagnosticsTitle = import.meta.env.DEV && searchDiagnostics
    ? `Search used ${searchDiagnostics.engine} in ${searchDiagnostics.elapsedMs} ms (${searchDiagnostics.resultCount}${searchDiagnostics.truncated ? '+' : ''} results)`
    : undefined

  useEffect(() => {
    latestSearchQueryRef.current = query
  }, [query])

  useEffect(() => {
    latestSearchExcludesRef.current = searchExcludes
  }, [searchExcludes])

  useEffect(() => {
    latestGitStatusRef.current = gitStatus
  }, [gitStatus])

  useEffect(() => {
    activeRowsRef.current = activeRows
  }, [activeRows])

  useEffect(() => {
    const updateBackgroundDragSelection = (clientY: number) => {
      const dragSelection = dragSelectionRef.current
      if (!dragSelection || dragSelection.kind !== 'background') return

      const rangePaths = fileExplorerSelectionFromVerticalRange(
        activeRowsRef.current
          .map((row) => {
            const node = rowRefs.current[row.entry.path]
            if (!node) return null
            const rect = node.getBoundingClientRect()
            return { path: row.entry.path, top: rect.top, bottom: rect.bottom }
          })
          .filter((row): row is { path: string; top: number; bottom: number } => Boolean(row)),
        dragSelection.startY,
        clientY
      )

      completedDragSelectionRef.current = rangePaths.length > 0
      setSelectedPath(rangePaths.at(-1) ?? null)
      setSelectedPaths(new Set(rangePaths))
    }

    const handleMouseMove = (event: MouseEvent) => {
      updateBackgroundDragSelection(event.clientY)
    }

    const handleMouseUp = () => {
      if (dragSelectionRef.current) {
        dragSelectionRef.current = null
        window.setTimeout(() => {
          completedDragSelectionRef.current = false
        }, 0)
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const renamingPath = renameDraft?.entry.path ?? null

  const commitExpandedPaths = useCallback((next: Record<string, boolean>) => {
    latestExpandedPathsRef.current = next
    setExpandedPathsState(next)
    setFileExplorerExpandedPaths(workspaceId, expandedPathListFromRecord(next))
  }, [setFileExplorerExpandedPaths, workspaceId])

  const setExpandedPaths = useCallback((
    update: Record<string, boolean> | ((current: Record<string, boolean>) => Record<string, boolean>)
  ) => {
    const current = latestExpandedPathsRef.current
    commitExpandedPaths(typeof update === 'function' ? update(current) : update)
  }, [commitExpandedPaths])

  const showError = useCallback((error: unknown, fallback?: string) => {
    setErrorToast(error instanceof Error ? error.message : fallback ?? String(error))
  }, [])

  const applySearchResponse = useCallback((response: FileSearchResponse) => {
    setSearchResults(response.entries)
    setSearchDiagnostics(response.diagnostics)

    if (response.diagnostics) {
      logPerfEvent('FileExplorer', 'search-files', {
        rootPath,
        query: latestSearchQueryRef.current,
        ...response.diagnostics,
      })
    }
  }, [rootPath])

  useEffect(() => {
    if (!renamingPath) return
    window.setTimeout(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }, 0)
  }, [renamingPath])

  const loadDirectory = useCallback(async (dirPath: string) => {
    const raw = await window.api.readdir(dirPath)
    const entries = mergeGitDeletedEntries(toEntries(raw, dirPath), dirPath, latestGitStatusRef.current)

    if (dirPath === rootPath) {
      setRootEntries(entries)
    } else {
      setChildrenByPath((current) => ({ ...current, [dirPath]: entries }))
    }

    return entries
  }, [rootPath])

  const ensureDirectoryLoaded = async (dirPath: string) => {
    if (dirPath === rootPath || childrenByPath[dirPath]) return
    await loadDirectory(dirPath)
  }

  const focusTree = () => {
    containerRef.current?.focus()
  }

  const selectOnlyEntry = (entry: Entry) => {
    selectionAnchorPathRef.current = entry.path
    setSelectedPath(entry.path)
    setSelectedPaths(new Set([entry.path]))
  }

  const selectEntryRange = (anchorPath: string, targetPath: string) => {
    const rangePaths = fileExplorerSelectionRange(
      activeRowsRef.current.map((row) => row.entry.path),
      anchorPath,
      targetPath
    )

    if (!rangePaths.length) {
      return
    }

    setSelectedPaths(new Set(rangePaths))
  }

  const beginBackgroundDragSelection = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.target instanceof Element && event.target.closest('[data-file-explorer-row="true"]')) return

    event.preventDefault()
    dragSelectionRef.current = { kind: 'background', startY: event.clientY, active: true }
    completedDragSelectionRef.current = false
    selectionAnchorPathRef.current = null
    setSelectedPath(null)
    setSelectedPaths(new Set())
    focusTree()
  }

  const selectEntry = (entry: Entry, event?: React.MouseEvent<HTMLDivElement>) => {
    setSelectedPath(entry.path)

    if (event?.shiftKey && selectionAnchorPathRef.current) {
      selectEntryRange(selectionAnchorPathRef.current, entry.path)
      return
    }

    if (event?.metaKey || event?.ctrlKey) {
      selectionAnchorPathRef.current = entry.path
      setSelectedPaths((current) => {
        const next = new Set(current)
        if (next.has(entry.path) && next.size > 1) {
          next.delete(entry.path)
        } else {
          next.add(entry.path)
        }
        return next
      })
      return
    }

    selectOnlyEntry(entry)
  }

  const refreshParentDirectory = async (parentPath: string) => {
    await loadDirectory(parentPath)
  }

  const refreshTree = useCallback(async (cause: RefreshTreeCause = 'manual') => {
    const startedAt = performance.now()
    const expandedDirectories = Object.entries(latestExpandedPathsRef.current)
      .filter(([, expanded]) => expanded)
      .map(([dirPath]) => dirPath)

    const directories = Array.from(new Set([rootPath, ...expandedDirectories]))
    let loadedDirectoryCount = 0
    await Promise.all(
      directories.map(async (dirPath) => {
        try {
          await loadDirectory(dirPath)
          loadedDirectoryCount += 1
        } catch (error) {
          if (dirPath === rootPath) {
            throw error
          }

          setChildrenByPath((current) => {
            if (!(dirPath in current)) return current
            const next = { ...current }
            delete next[dirPath]
            return next
          })
          setExpandedPaths((current) => {
            if (!(dirPath in current)) return current
            const next = { ...current }
            delete next[dirPath]
            return next
          })
        }
      })
    )

    logPerfEvent('FileExplorer', 'refresh-tree', {
      cause,
      rootPath,
      elapsedMs: Math.round(performance.now() - startedAt),
      expandedDirectoryCount: expandedDirectories.length,
      loadedDirectoryCount,
      isSearching: latestSearchQueryRef.current.trim().length > 0,
    })
  }, [loadDirectory, rootPath])

  const scheduleRefresh = useCallback(() => {
    if (refreshTimeoutRef.current) {
      window.clearTimeout(refreshTimeoutRef.current)
    }

    refreshTimeoutRef.current = window.setTimeout(() => {
      refreshTimeoutRef.current = null
      void refreshTree('watch')
    }, 150)
  }, [refreshTree])

  const toggleDirectory = async (entry: Entry) => {
    if (!entry.isDir) return
    const isExpanded = latestExpandedPathsRef.current[entry.path] === true
    if (!isExpanded) {
      await ensureDirectoryLoaded(entry.path)
    }
    setExpandedPaths((current) => {
      if (!isExpanded) {
        return { ...current, [entry.path]: true }
      }

      return Object.fromEntries(
        Object.entries(current).filter(([path]) => !isPathOrChild(path, entry.path))
      )
    })
  }

  const activateEntry = async (entry: Entry) => {
    selectOnlyEntry(entry)
    if (isSearching && entry.isDir) {
      focusTree()
      return
    }
    if (isSearching || !entry.isDir) {
      await onOpenFile(entry.path, entry.name)
      return
    }
    await toggleDirectory(entry)
  }

  const createEntry = async (targetDir: string, kind: 'file' | 'dir') => {
    const defaultName = kind === 'file' ? 'untitled.ts' : 'new-folder'
    const rawName = await dialog.prompt({
      title: kind === 'file' ? 'New file' : 'New folder',
      inputLabel: kind === 'file' ? 'File name' : 'Folder name',
      initialValue: defaultName,
      confirmLabel: 'Create',
      required: true,
    })
    const name = rawName?.trim()
    if (!name) return

    try {
      const newPath =
        kind === 'file'
          ? await window.api.createFile(targetDir, name)
          : await window.api.createDir(targetDir, name)

      if (targetDir !== rootPath) {
        setExpandedPaths((current) => ({ ...current, [targetDir]: true }))
      }

      await refreshParentDirectory(targetDir)
      selectOnlyEntry({
        name,
        isDir: kind === 'dir',
        path: newPath,
        parentPath: targetDir,
      })

      if (kind === 'file') {
        openFile(workspaceId, newPath, name, '')
        focusOrAddFileTab(workspaceId, newPath, name)
      }
      void refreshGitStatus()
    } catch (error) {
      showError(error)
    }
  }

  useEffect(() => {
    if (!createRequest || createRequest.token === lastCreateRequestTokenRef.current) return
    lastCreateRequestTokenRef.current = createRequest.token
    void createEntry(rootPath, createRequest.kind)
  }, [createRequest?.token])

  const startRename = (entry: Entry) => {
    selectOnlyEntry(entry)
    setRenameDraft({ entry, value: entry.name })
  }

  const cancelRename = () => {
    setRenameDraft(null)
    focusTree()
  }

  const commitRename = async () => {
    if (!renameDraft || committingRenameRef.current) return

    const { entry } = renameDraft
    const nextName = renameDraft.value.trim()
    if (!nextName || nextName === entry.name) {
      setRenameDraft(null)
      focusTree()
      return
    }

    try {
      committingRenameRef.current = true
      const nextPath = await window.api.renamePath(entry.path, nextName)
      remapOpenFiles(workspaceId, entry.path, nextPath)
      remapFileTabsForPath(workspaceId, entry.path, nextPath)

      if (entry.isDir) {
        setChildrenByPath((current) => remapChildrenByPath(current, entry.path, nextPath))
        setExpandedPaths((current) => remapExpandedPaths(current, entry.path, nextPath))
      }

      await refreshParentDirectory(entry.parentPath)
      if (isSearching) {
        applySearchResponse(await searchFiles(
          rootPath,
          latestSearchQueryRef.current,
          latestGitStatusRef.current,
          latestSearchExcludesRef.current
        ))
      }
      selectionAnchorPathRef.current = nextPath
      setSelectedPath(nextPath)
      setSelectedPaths(new Set([nextPath]))
      setRenameDraft(null)
      focusTree()
      void refreshGitStatus()
    } catch (error) {
      showError(error)
    } finally {
      committingRenameRef.current = false
    }
  }

  const pasteIntoDirectory = async (targetDir: string) => {
    if (!clipboard) return

    try {
      const newPath = await window.api.copyPath(clipboard.path, targetDir)
      setExpandedPaths((current) => ({ ...current, [targetDir]: true }))
      await refreshParentDirectory(targetDir)
      selectionAnchorPathRef.current = newPath
      setSelectedPath(newPath)
      setSelectedPaths(new Set([newPath]))
      void refreshGitStatus()
    } catch (error) {
      showError(error)
    }
  }

  const deleteEntries = async (entries: Entry[]) => {
    const deletableEntries = entries.filter((entry) => !entry.gitDeleted)
    if (!deletableEntries.length) return

    if (typeof window.api.deletePath !== 'function') {
      showError('Delete support is not loaded yet. Restart the app so Electron reloads the preload script.')
      return
    }

    const topLevelEntries = deletableEntries.filter(
      (entry) => !deletableEntries.some((candidate) => candidate.path !== entry.path && isPathOrChild(entry.path, candidate.path))
    )
    const targetLabel = topLevelEntries.length === 1
      ? topLevelEntries[0].isDir
        ? `folder "${topLevelEntries[0].name}" and its contents`
        : `file "${topLevelEntries[0].name}"`
      : `${topLevelEntries.length} selected items`
    const confirmed = await dialog.confirm({
      title: 'Move to Trash?',
      body: `This moves ${targetLabel} to the system Trash. You can restore it from Trash until it is emptied.`,
      confirmLabel: 'Move to Trash',
      tone: 'danger',
    })
    if (!confirmed) return

    try {
      await Promise.all(topLevelEntries.map((entry) => window.api.deletePath(entry.path)))
      topLevelEntries.forEach((entry) => {
        removeOpenFilesForPath(workspaceId, entry.path)
        removeFileTabsForPath(workspaceId, entry.path)
      })

      setChildrenByPath((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([path]) => !topLevelEntries.some((entry) => isPathOrChild(path, entry.path)))
        )
      )
      setExpandedPaths((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([path]) => !topLevelEntries.some((entry) => isPathOrChild(path, entry.path)))
        )
      )
      setSearchResults((current) =>
        current.filter((result) => !topLevelEntries.some((entry) => isPathOrChild(result.path, entry.path)))
      )
      setClipboard((current) =>
        current && topLevelEntries.some((entry) => isPathOrChild(current.path, entry.path)) ? null : current
      )

      await Promise.all(Array.from(new Set(topLevelEntries.map((entry) => entry.parentPath))).map(refreshParentDirectory))
      const nextSelection = isSearching ? null : topLevelEntries[0]?.parentPath ?? null
      selectionAnchorPathRef.current = nextSelection
      setSelectedPath(nextSelection)
      setSelectedPaths(nextSelection ? new Set([nextSelection]) : new Set())
      void refreshGitStatus()
    } catch (error) {
      showError(error)
    }
  }

  const startFuturePlan = async (entry: Entry, sourcePlanKind: SprintEngineSourcePlanKind) => {
    const sourceRelativePath = markdownSourceRelativePath(rootPath, entry)
    if (!sourceRelativePath || !onStartFuturePlan) return

    const basename = planBasename(entry.name)
    const fallbackGoal = titleCasePlanName(basename)

    try {
      const sourceContent = await window.api.readfile(entry.path)
      onStartFuturePlan({
        folderPath: rootPath,
        sourcePath: entry.path,
        sourceRelativePath,
        sourceContent,
        sourcePlanKind,
        teamName: slugifySprintEngineName(basename),
        goal: markdownTitle(sourceContent) ?? fallbackGoal,
      })
    } catch (error) {
      showError(error, 'Could not read the selected markdown file.')
    }
  }

  const startFuturePlanBundle = async (entries: Entry[]) => {
    if (!onStartFuturePlan) return
    const sourceEntries = entries.filter((candidate) => isSourceBundleFile(rootPath, candidate))
    if (sourceEntries.length === 0) return

    try {
      const sourceBundle: SprintEngineSourceBundleItem[] = await Promise.all(sourceEntries.map(async (sourceEntry) => {
        const sourceContent = await window.api.readfile(sourceEntry.path)
        const sourceRelativePath = sourceBundleRelativePath(rootPath, sourceEntry)
        if (!sourceRelativePath) throw new Error(`Unsupported source file: ${sourceEntry.name}`)
        return {
          kind: isHtmlFile(sourceEntry) ? 'html_mockup' : inferSourcePlanKind(sourceRelativePath, sourceContent),
          sourcePath: sourceEntry.path,
          sourceRelativePath,
          sourceContent,
        }
      }))
      const primary = sourceBundle.find((item) => item.kind === 'architect_plan')
        ?? sourceBundle.find((item) => item.kind === 'product_plan')
        ?? sourceBundle[0]
      const basename = planBasename(primary.sourceRelativePath.split('/').pop() ?? 'source-bundle')
      const firstMarkdown = sourceBundle.find((item) => /\.md$/i.test(item.sourceRelativePath))
      onStartFuturePlan({
        folderPath: rootPath,
        sourcePath: primary.sourcePath,
        sourceRelativePath: primary.sourceRelativePath,
        sourceContent: primary.sourceContent,
        sourcePlanKind: primary.kind === 'product_plan' || primary.kind === 'architect_plan' ? primary.kind : 'unknown',
        sourceBundle,
        teamName: slugifySprintEngineName(basename),
        goal: (firstMarkdown ? markdownTitle(firstMarkdown.sourceContent) : null) ?? titleCasePlanName(basename),
      })
    } catch (error) {
      showError(error, 'Could not read the selected source files.')
    }
  }

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>, entry: Entry) => {
    if (dragSelectionRef.current?.active) {
      event.preventDefault()
      return
    }

    if (entry.gitDeleted) {
      event.preventDefault()
      return
    }

    const dragEntries = topLevelEntries(
      (selectedPaths.has(entry.path) ? selectedEntries : [entry])
        .filter((selectedEntry) => !selectedEntry.gitDeleted)
    )
    if (!dragEntries.length) {
      event.preventDefault()
      return
    }

    const movePayload: ExplorerMovePayload = {
      version: 1,
      workspaceId,
      rootPath,
      entries: dragEntries,
    }
    activeMoveDragRef.current = movePayload
    setSelectedPath(entry.path)
    if (!selectedPaths.has(entry.path)) {
      selectionAnchorPathRef.current = entry.path
      setSelectedPaths(new Set([entry.path]))
    }
    setFileDropData(event.dataTransfer, {
      version: 1,
      workspaceId,
      rootPath,
      files: dragEntries.map((selectedEntry) => ({
        path: selectedEntry.path,
        name: selectedEntry.name,
        isDir: selectedEntry.isDir,
      })),
    })
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData(MULTICODE_EXPLORER_MOVE_MIME, JSON.stringify(movePayload))
  }

  const readMoveDragPayload = (dataTransfer: DataTransfer): ExplorerMovePayload | null => {
    const payload = activeMoveDragRef.current ?? parseExplorerMovePayload(dataTransfer)
    if (!payload) return null
    if (payload.workspaceId !== workspaceId) return null
    if (normalizePathKey(payload.rootPath) !== normalizePathKey(rootPath)) return null
    return payload
  }

  const canDropMovePayload = (payload: ExplorerMovePayload, targetDir: string): boolean => {
    return payload.entries.some((entry) => (
      !entry.gitDeleted
      && entry.parentPath !== targetDir
      && entry.path !== targetDir
      && !isPathOrChild(targetDir, entry.path)
    ))
  }

  const moveEntriesIntoDirectory = async (entries: Entry[], targetDir: string) => {
    const movableEntries = topLevelEntries(entries.filter((entry) => !entry.gitDeleted))
    if (!movableEntries.length) return

    const invalidTarget = movableEntries.find((entry) => entry.path === targetDir || isPathOrChild(targetDir, entry.path))
    if (invalidTarget) {
      showError(`Cannot move "${invalidTarget.name}" into itself.`)
      return
    }

    const entriesToMove = movableEntries.filter((entry) => entry.parentPath !== targetDir)
    if (!entriesToMove.length) return

    const parentDirectories = new Set(entriesToMove.flatMap((entry) => [entry.parentPath, targetDir]))
    const movedEntries: Array<{ entry: Entry; nextPath: string }> = []
    const selectMovedEntries = () => {
      const movedPaths = movedEntries.map((moved) => moved.nextPath)
      selectionAnchorPathRef.current = movedPaths[0] ?? null
      setSelectedPath(movedPaths[0] ?? null)
      setSelectedPaths(new Set(movedPaths))
    }

    try {
      for (const entry of entriesToMove) {
        const nextPath = await window.api.movePath(entry.path, targetDir)
        if (nextPath === entry.path) continue
        movedEntries.push({ entry, nextPath })
        remapOpenFiles(workspaceId, entry.path, nextPath)
        remapFileTabsForPath(workspaceId, entry.path, nextPath)
      }

      if (!movedEntries.length) return

      setChildrenByPath((current) =>
        movedEntries.reduce(
          (next, moved) => moved.entry.isDir ? remapChildrenByPath(next, moved.entry.path, moved.nextPath) : next,
          current
        )
      )
      setExpandedPaths((current) => ({
        ...movedEntries.reduce(
          (next, moved) => moved.entry.isDir ? remapExpandedPaths(next, moved.entry.path, moved.nextPath) : next,
          current
        ),
        [targetDir]: true,
      }))

      await Promise.all(Array.from(parentDirectories).map(refreshParentDirectory))
      if (isSearching) {
        applySearchResponse(await searchFiles(
          rootPath,
          latestSearchQueryRef.current,
          latestGitStatusRef.current,
          latestSearchExcludesRef.current
        ))
      }

      selectMovedEntries()
      focusTree()
      void refreshGitStatus()
    } catch (error) {
      showError(error, 'Could not move the selected file.')
      if (movedEntries.length) {
        await Promise.all(Array.from(parentDirectories).map(refreshParentDirectory))
        if (isSearching) {
          applySearchResponse(await searchFiles(
            rootPath,
            latestSearchQueryRef.current,
            latestGitStatusRef.current,
            latestSearchExcludesRef.current
          ))
        }
        selectMovedEntries()
        void refreshGitStatus()
      }
    }
  }

  // Copy OS files/folders dropped from Finder (etc.) into a directory in the
  // tree. Each copy is independent so one name collision does not abort the rest.
  const copyExternalFilesIntoDirectory = async (sourcePaths: string[], targetDir: string) => {
    if (!sourcePaths.length) return
    if (typeof window.api.copyPathInto !== 'function') {
      showError('Copying files into the explorer is not supported in this build.')
      return
    }

    const copiedPaths: string[] = []
    const errors: string[] = []
    for (const sourcePath of sourcePaths) {
      try {
        copiedPaths.push(await window.api.copyPathInto(sourcePath, targetDir))
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }

    if (errors.length) {
      showError(errors.join('\n'))
    }

    setExpandedPaths((current) => ({ ...current, [targetDir]: true }))
    await refreshParentDirectory(targetDir)
    if (isSearching) {
      applySearchResponse(await searchFiles(
        rootPath,
        latestSearchQueryRef.current,
        latestGitStatusRef.current,
        latestSearchExcludesRef.current
      ))
    }

    if (copiedPaths.length) {
      selectionAnchorPathRef.current = copiedPaths[0]
      setSelectedPath(copiedPaths[0])
      setSelectedPaths(new Set(copiedPaths))
      focusTree()
    }
    void refreshGitStatus()
  }

  const handleFolderDragOver = (event: React.DragEvent<HTMLDivElement>, entry: Entry) => {
    if (!entry.isDir || entry.gitDeleted) return

    // In-app move takes precedence over an external copy.
    if (hasExplorerMovePayload(event.dataTransfer) || activeMoveDragRef.current) {
      const payload = readMoveDragPayload(event.dataTransfer)
      if (!payload || !canDropMovePayload(payload, entry.path)) {
        event.dataTransfer.dropEffect = 'none'
        setDropTargetPath(null)
        return
      }

      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      setDropTargetPath(entry.path)
      return
    }

    if (hasNativeFileDrop(event.dataTransfer)) {
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
      setRootDropActive(false)
      setDropTargetPath(entry.path)
    }
  }

  const handleFolderDragLeave = (event: React.DragEvent<HTMLDivElement>, entry: Entry) => {
    if (dropTargetPath !== entry.path) return
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    setDropTargetPath(null)
  }

  const handleFolderDrop = (event: React.DragEvent<HTMLDivElement>, entry: Entry) => {
    if (!entry.isDir || entry.gitDeleted) return

    if (hasNativeFileDrop(event.dataTransfer) && !hasExplorerMovePayload(event.dataTransfer) && !activeMoveDragRef.current) {
      event.preventDefault()
      event.stopPropagation()
      setDropTargetPath(null)
      void copyExternalFilesIntoDirectory(collectNativeDropPaths(event.dataTransfer), entry.path)
      return
    }

    const payload = readMoveDragPayload(event.dataTransfer)
    if (!payload || !canDropMovePayload(payload, entry.path)) return

    event.preventDefault()
    event.stopPropagation()
    setDropTargetPath(null)
    void moveEntriesIntoDirectory(payload.entries, entry.path)
  }

  const handleDragEnd = () => {
    activeMoveDragRef.current = null
    setDropTargetPath(null)
    setRootDropActive(false)
  }

  // Drops on empty space or a non-folder row fall through to here and copy into
  // the workspace root. Folder rows stop propagation, so this never double-fires.
  const handleRootDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (hasExplorerMovePayload(event.dataTransfer) || activeMoveDragRef.current) return
    if (!hasNativeFileDrop(event.dataTransfer)) return

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropTargetPath(null)
    setRootDropActive(true)
  }

  const handleRootDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    setRootDropActive(false)
  }

  const handleRootDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (hasExplorerMovePayload(event.dataTransfer) || activeMoveDragRef.current) return
    if (!hasNativeFileDrop(event.dataTransfer)) return

    event.preventDefault()
    setRootDropActive(false)
    void copyExternalFilesIntoDirectory(collectNativeDropPaths(event.dataTransfer), rootPath)
  }

  const showContextMenu = async (event: React.MouseEvent, entry?: Entry) => {
    event.preventDefault()
    event.stopPropagation()
    focusTree()

    const contextSelection = entry && selectedPaths.has(entry.path) ? selectedEntries : entry ? [entry] : []

    if (entry && !selectedPaths.has(entry.path)) {
      selectOnlyEntry(entry)
    }

    const targetDir = entry ? (entry.isDir ? entry.path : entry.parentPath) : rootPath
    const canUsePathCommands = contextSelection.length > 0 && contextSelection.every((selectedEntry) => !selectedEntry.gitDeleted)
    const isSingleSelection = contextSelection.length === 1
    const gitDiffEntry = isSingleSelection && entry && !entry.isDir
      ? getGitEntry(latestGitStatusRef.current, entry.path)
      : null
    const canViewGitDiff = Boolean(
      isSingleSelection && entry && !entry.isDir && latestGitStatusRef.current?.repoRoot
      && (gitDiffEntry || entry.gitDeleted)
    )
    const canDeletePath = canUsePathCommands && typeof window.api.deletePath === 'function'
    const canStartFuturePlan = Boolean(
      isSingleSelection && entry && canUsePathCommands && markdownSourceRelativePath(rootPath, entry)
    )
    const canStartFuturePlanBundle = Boolean(
      canUsePathCommands
      && contextSelection.every((selectedEntry) => isSourceBundleFile(rootPath, selectedEntry))
      && (contextSelection.length > 1 || (isSingleSelection && entry && isHtmlFile(entry)))
    )
    const hasSourceBundleOutsideBacklog = Boolean(
      canUsePathCommands
      && (contextSelection.length > 1 || (isSingleSelection && entry && isHtmlFile(entry)))
      && contextSelection.some(isPotentialSourceBundleFile)
      && contextSelection.some((selectedEntry) => isPotentialSourceBundleFile(selectedEntry) && !isSourceBundleFile(rootPath, selectedEntry))
    )
    const deleteLabel = contextSelection.length > 1
      ? canDeletePath
        ? `Delete ${contextSelection.length} Items`
        : 'Delete Items (restart app)'
      : canDeletePath
        ? 'Delete'
        : 'Delete (restart app)'
    const command = await window.api.showContextMenu([
      ...(isSingleSelection && entry && !entry.isDir && canUsePathCommands ? [{ id: 'open', label: 'Open' }] : []),
      ...(isSingleSelection && entry && isHtmlFile(entry) && canUsePathCommands ? [{ id: 'open-in-browser', label: 'Open in Browser' }] : []),
      ...(isSingleSelection && entry && !entry.isDir && canUsePathCommands ? [{ id: 'open-in-explorer', label: 'Open in Explorer' }] : []),
      ...(canViewGitDiff ? [{ id: 'view-git-diff', label: 'View Git Diff' }] : []),
      ...(canStartFuturePlan
        ? [{
          label: 'Run a Sprint From',
          submenu: [
            { id: 'create-markdown-sprintengine-product', label: 'Product Plan...' },
            { id: 'create-markdown-sprintengine-architect', label: 'Implementation Plan...' },
            { type: 'separator' as const },
            { id: 'create-markdown-sprintengine-generic', label: 'Generic Handoff...' },
          ],
        }]
        : []),
      ...(canStartFuturePlanBundle ? [{ id: 'create-source-bundle-sprintengine', label: `Run a Sprint From ${contextSelection.length === 1 ? 'Source' : `${contextSelection.length} Sources`}...` }] : []),
      ...(hasSourceBundleOutsideBacklog ? [{
        id: 'source-bundle-backlog-only',
        label: 'Source bundles must be under backlog/',
        enabled: false,
      }] : []),
      ...(isSingleSelection && entry?.isDir && !isSearching && canUsePathCommands
        ? [{ id: expandedPaths[entry.path] ? 'collapse' : 'expand', label: expandedPaths[entry.path] ? 'Collapse' : 'Expand' }]
        : []),
      ...(entry ? [{ type: 'separator' as const }] : []),
      { id: 'new-file', label: 'New File' },
      { id: 'new-folder', label: 'New Folder' },
      { type: 'separator' as const },
      ...(isSingleSelection && entry && canUsePathCommands ? [{ id: 'copy', label: 'Copy' }] : []),
      { id: 'paste', label: 'Paste', enabled: Boolean(clipboard) && !isSearching },
      ...(isSingleSelection && entry && canUsePathCommands ? [{ id: 'rename', label: 'Rename' }] : []),
      ...(entry ? [{ id: 'delete', label: deleteLabel, enabled: canDeletePath }] : []),
      { type: 'separator' as const },
      { id: 'refresh', label: 'Refresh' },
    ])

    if (!command) return
    if (command === 'open' && entry) return void activateEntry(entry)
    if (command === 'open-in-browser' && entry && isHtmlFile(entry)) {
      try {
        await window.api.openHtmlFileInBrowser(entry.path)
      } catch (error) {
        showError(error)
      }
      return
    }
    if (command === 'open-in-explorer' && entry && !entry.isDir) {
      try {
        await window.api.showItemInFolder(entry.path)
      } catch (error) {
        showError(error)
      }
      return
    }
    if (command === 'view-git-diff' && entry && !entry.isDir) {
      const repoRoot = latestGitStatusRef.current?.repoRoot
      if (repoRoot) {
        const gitEntry = getGitEntry(latestGitStatusRef.current, entry.path)
        const scope = gitEntry?.staged && !gitEntry.unstaged ? 'staged' : 'unstaged'
        await openDiffWindow({ repoRoot, focusPath: entry.path, scope })
      }
      return
    }
    if (command === 'create-markdown-sprintengine-product' && entry) return void startFuturePlan(entry, 'product_plan')
    if (command === 'create-markdown-sprintengine-architect' && entry) return void startFuturePlan(entry, 'architect_plan')
    if (command === 'create-markdown-sprintengine-generic' && entry) return void startFuturePlan(entry, 'unknown')
    if (command === 'create-source-bundle-sprintengine') return void startFuturePlanBundle(contextSelection)
    if (command === 'expand' && entry?.isDir) {
      if (!expandedPaths[entry.path]) {
        await ensureDirectoryLoaded(entry.path)
        setExpandedPaths((current) => ({ ...current, [entry.path]: true }))
      }
      return
    }
    if (command === 'collapse' && entry?.isDir) {
      setExpandedPaths((current) => ({ ...current, [entry.path]: false }))
      return
    }
    if (command === 'new-file') return void createEntry(targetDir, 'file')
    if (command === 'new-folder') return void createEntry(targetDir, 'dir')
    if (command === 'copy' && entry) {
      setClipboard({ path: entry.path, isDir: entry.isDir })
      return
    }
    if (command === 'paste' && !isSearching) return void pasteIntoDirectory(targetDir)
    if (command === 'rename' && entry) return startRename(entry)
    if (command === 'delete' && contextSelection.length) return void deleteEntries(contextSelection)
    if (command === 'refresh') {
      if (isSearching || targetDir === rootPath) {
        await refreshTree('manual')
      } else {
        await refreshParentDirectory(targetDir)
      }
      await refreshGitStatus()
    }
  }

  useEffect(() => {
    let cancelled = false
    const restoredExpandedPaths = expandedPathRecordFromList(readPersistedExpandedPaths(), rootPath)
    // Block selection persistence until the initial restore runs, so the
    // pre-restore null below (or a slow tree load) cannot overwrite the saved
    // selection before we read it.
    hasRestoredSelectionRef.current = false
    setLoading(true)
    setRootEntries([])
    setChildrenByPath({})
    latestExpandedPathsRef.current = restoredExpandedPaths
    setExpandedPathsState(restoredExpandedPaths)
    setSelectedPath(null)
    setSelectedPaths(new Set())
    selectionAnchorPathRef.current = null

    const startedAt = performance.now()
    const loadInitialTree = async () => {
      const entries = await loadDirectory(rootPath)
      if (cancelled) return

      const expandedDirectories = Object.keys(restoredExpandedPaths).filter((dirPath) => dirPath !== rootPath)
      const existingExpandedPaths = { ...restoredExpandedPaths }
      let loadedDirectoryCount = 1

      await Promise.all(expandedDirectories.map(async (dirPath) => {
        try {
          await loadDirectory(dirPath)
          loadedDirectoryCount += 1
        } catch {
          delete existingExpandedPaths[dirPath]
        }
      }))
      if (cancelled) return

      if (Object.keys(existingExpandedPaths).length !== Object.keys(restoredExpandedPaths).length) {
        commitExpandedPaths(existingExpandedPaths)
      }

      return { entries, expandedDirectoryCount: expandedDirectories.length, loadedDirectoryCount }
    }

    loadInitialTree()
      .then((result) => {
        if (!result || cancelled) return
        const { entries, expandedDirectoryCount, loadedDirectoryCount } = result
        const firstPath = entries[0]?.path ?? null
        // Restore the last-selected file once every expanded directory is loaded
        // (so its row is flattened into the tree). If it is no longer under the
        // root or its ancestors are collapsed/gone, the selection-validity effect
        // below replaces it with the first row — graceful for deleted files.
        const persistedSelectedPath = readPersistedSelectedPath()
        const restorePath =
          persistedSelectedPath && isPathOrChild(persistedSelectedPath, rootPath) ? persistedSelectedPath : firstPath
        setSelectedPath(restorePath)
        setSelectedPaths(restorePath ? new Set([restorePath]) : new Set())
        selectionAnchorPathRef.current = restorePath
        // The saved selection has now been read; later changes may persist.
        hasRestoredSelectionRef.current = true
        logPerfEvent('FileExplorer', 'refresh-tree', {
          cause: 'initial',
          rootPath,
          elapsedMs: Math.round(performance.now() - startedAt),
          expandedDirectoryCount,
          loadedDirectoryCount,
          isSearching: false,
        })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [commitExpandedPaths, loadDirectory, readPersistedExpandedPaths, readPersistedSelectedPath, rootPath])

  useEffect(() => {
    if (refreshToken === lastManualRefreshRef.current) return
    lastManualRefreshRef.current = refreshToken
    void refreshTree('manual')
    void refreshGitStatus()
  }, [refreshGitStatus, refreshToken, refreshTree])

  useEffect(() => {
    if (!revealToken || !revealPath || !isPathOrChild(revealPath, rootPath)) return

    let cancelled = false

    const revealFile = async () => {
      const startedAt = performance.now()
      const parentDirectories = parentDirectoriesForPath(rootPath, revealPath)

      for (const directory of parentDirectories) {
        await loadDirectory(directory)
        if (cancelled) return
      }

      setExpandedPaths((current) => ({
        ...current,
        ...Object.fromEntries(parentDirectories.map((directory) => [directory, true])),
      }))
      setSelectedPath(revealPath)
      setSelectedPaths(new Set([revealPath]))
      selectionAnchorPathRef.current = revealPath
      logPerfEvent('FileExplorer', 'refresh-tree', {
        cause: 'reveal',
        rootPath,
        elapsedMs: Math.round(performance.now() - startedAt),
        expandedDirectoryCount: parentDirectories.length,
        loadedDirectoryCount: parentDirectories.length,
        isSearching: false,
      })

      window.setTimeout(() => {
        if (cancelled) return
        rowRefs.current[revealPath]?.scrollIntoView({ block: 'nearest' })
      }, 0)
    }

    void revealFile()

    return () => {
      cancelled = true
    }
  }, [loadDirectory, revealPath, revealToken, rootPath])

  useEffect(() => {
    void refreshTree('git-status')
  }, [gitStatus?.updatedAt, refreshTree])

  useEffect(() => {
    if (!isSearching) {
      searchRequestSeqRef.current += 1
      if (searchTimeoutRef.current) {
        window.clearTimeout(searchTimeoutRef.current)
        searchTimeoutRef.current = null
      }
      setSearchResults([])
      setSearchDiagnostics(null)
      setSearching(false)
      return
    }

    const requestSeq = ++searchRequestSeqRef.current
    setSearching(true)
    if (searchTimeoutRef.current) {
      window.clearTimeout(searchTimeoutRef.current)
    }

    searchTimeoutRef.current = window.setTimeout(() => {
      searchTimeoutRef.current = null
      searchFiles(rootPath, query, latestGitStatusRef.current, latestSearchExcludesRef.current)
        .then((response) => {
          if (requestSeq !== searchRequestSeqRef.current) return
          applySearchResponse(response)
          const firstPath = response.entries[0]?.path ?? null
          setSelectedPath(firstPath)
          setSelectedPaths(firstPath ? new Set([firstPath]) : new Set())
          selectionAnchorPathRef.current = firstPath
        })
        .catch(() => {
          if (requestSeq === searchRequestSeqRef.current) {
            setSearchResults([])
            setSearchDiagnostics(null)
          }
        })
        .finally(() => {
          if (requestSeq === searchRequestSeqRef.current) setSearching(false)
        })
    }, 180)

    return () => {
      if (searchTimeoutRef.current) {
        window.clearTimeout(searchTimeoutRef.current)
        searchTimeoutRef.current = null
      }
    }
  }, [applySearchResponse, rootPath, query, isSearching, searchExcludes])

  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => Promise<void>) | undefined

    window.api.watchPath(rootPath, (event) => {
      if (isIgnoredExplorerWatchPath(event.path)) return
      scheduleRefresh()
    })
      .then((cleanup) => {
        if (disposed) {
          void cleanup()
          return
        }
        unsubscribe = cleanup
      })
      .catch(() => {
        // Some filesystems do not support watch events reliably.
      })

    return () => {
      disposed = true
      if (refreshTimeoutRef.current) {
        window.clearTimeout(refreshTimeoutRef.current)
        refreshTimeoutRef.current = null
      }
      if (searchTimeoutRef.current) {
        window.clearTimeout(searchTimeoutRef.current)
        searchTimeoutRef.current = null
      }
      if (unsubscribe) {
        void unsubscribe()
      }
    }
  }, [rootPath, scheduleRefresh])

  useEffect(() => {
    if (!activeRows.length) {
      if (!loading && !searching) {
        setSelectedPath(null)
        setSelectedPaths(new Set())
        selectionAnchorPathRef.current = null
      }
      return
    }

    if (!selectedPath || !activeRows.some((row) => row.entry.path === selectedPath)) {
      const firstPath = activeRows[0].entry.path
      setSelectedPath(firstPath)
      setSelectedPaths(new Set([firstPath]))
      selectionAnchorPathRef.current = firstPath
      return
    }

    const activePathSet = new Set(activeRows.map((row) => row.entry.path))
    setSelectedPaths((current) => {
      const next = new Set(Array.from(current).filter((path) => activePathSet.has(path)))
      return next.size ? next : new Set([selectedPath])
    })
  }, [activeRows, loading, searching, selectedPath])

  // Persist the focused selection so a reload/restart restores the highlighted
  // file. Debounced because arrow-key navigation changes it rapidly and every
  // store write re-serializes the whole workspace registry. The debounce timer
  // is what survives a Cmd-R reload (React unmount cleanups do not run on a page
  // reload) and still fires on a layer switch, which does not unmount; the
  // separate unmount effect flushes the latest value when the panel/workspace is
  // actually closed so a quick select-then-close is not lost.
  const latestSelectedPathRef = useRef(selectedPath)
  latestSelectedPathRef.current = selectedPath
  useEffect(() => {
    if (!hasRestoredSelectionRef.current) return
    const handle = window.setTimeout(() => {
      setFileExplorerSelectedPath(workspaceId, latestSelectedPathRef.current)
    }, 300)
    return () => window.clearTimeout(handle)
  }, [selectedPath, workspaceId, setFileExplorerSelectedPath])
  useEffect(() => {
    return () => {
      if (!hasRestoredSelectionRef.current) return
      setFileExplorerSelectedPath(workspaceId, latestSelectedPathRef.current)
    }
  }, [workspaceId, setFileExplorerSelectedPath])

  const handleKeyDown = async (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (renameDraft) return
    if (!activeRows.length) return

    const currentIndex = Math.max(
      activeRows.findIndex((row) => row.entry.path === selectedPath),
      0
    )
    const currentEntry = activeRows[currentIndex].entry
    const moveSelection = (nextIndex: number) => {
      const nextRow = activeRows[nextIndex]
      setSelectedPath(nextRow.entry.path)

      if (event.shiftKey) {
        const anchorPath = selectionAnchorPathRef.current ?? currentEntry.path
        selectionAnchorPathRef.current = anchorPath
        selectEntryRange(anchorPath, nextRow.entry.path)
        return
      }

      selectionAnchorPathRef.current = nextRow.entry.path
      setSelectedPaths(new Set([nextRow.entry.path]))
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveSelection(Math.min(currentIndex + 1, activeRows.length - 1))
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSelection(Math.max(currentIndex - 1, 0))
      return
    }

    if (!isSearching && event.key === 'ArrowRight') {
      event.preventDefault()
      if (currentEntry.isDir && !expandedPaths[currentEntry.path]) {
        await ensureDirectoryLoaded(currentEntry.path)
        setExpandedPaths((current) => ({ ...current, [currentEntry.path]: true }))
        return
      }
      if (currentEntry.isDir && expandedPaths[currentEntry.path]) {
        const nextRow = activeRows[currentIndex + 1]
        if (nextRow?.entry.parentPath === currentEntry.path) {
          setSelectedPath(nextRow.entry.path)
        }
      }
      return
    }

    if (!isSearching && event.key === 'ArrowLeft') {
      event.preventDefault()
      if (currentEntry.isDir && expandedPaths[currentEntry.path]) {
        setExpandedPaths((current) => ({ ...current, [currentEntry.path]: false }))
        return
      }
      const parentRow = activeRows.find((row) => row.entry.path === currentEntry.parentPath)
      if (parentRow) {
        setSelectedPath(parentRow.entry.path)
      }
      return
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      await deleteEntries(selectedEntries.length ? selectedEntries : [currentEntry])
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      await activateEntry(currentEntry)
    }
  }

  const renderRenameInput = (className: string) => {
    if (!renameDraft) return null

    return (
      <input
        ref={renameInputRef}
        value={renameDraft.value}
        onChange={(event) =>
          setRenameDraft((current) => current ? { ...current, value: event.target.value } : current)
        }
        onBlur={() => void commitRename()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            void commitRename()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancelRename()
          }
        }}
        className={className}
      />
    )
  }

  if (loading) {
    return <div className="px-4 py-2 text-[11px] text-[color:var(--text-disabled)]">Loading...</div>
  }

  if (isSearching && searching) {
    return <div className="px-4 py-2 text-[11px] text-[color:var(--text-disabled)]">Searching...</div>
  }

  if (isSearching && activeRows.length === 0) {
    return <div className="px-4 py-2 text-[11px] text-[color:var(--text-disabled)]">No matching files</div>
  }

  return (
    <>
      {errorToast ? (
        <div className="sticky top-0 z-10 px-2 pb-1 pt-1">
          <Toast
            tone="error"
            title="File action failed"
            description={errorToast}
            onDismiss={() => setErrorToast(null)}
          />
        </div>
      ) : null}
      <div
        ref={containerRef}
        tabIndex={0}
        role="tree"
        title={searchDiagnosticsTitle}
        onKeyDown={(event) => void handleKeyDown(event)}
        onContextMenu={(event) => void showContextMenu(event)}
        onMouseDown={beginBackgroundDragSelection}
        onDragOver={handleRootDragOver}
        onDragLeave={handleRootDragLeave}
        onDrop={handleRootDrop}
        className={`flex min-h-full flex-col gap-px rounded-md px-1 py-1.5 outline-none focus:ring-1 focus:ring-[color:var(--border-strong)] ${
          rootDropActive ? 'ring-1 ring-inset ring-[color:var(--accent-primary)]' : ''
        }`}
      >
        {activeRows.map(({ entry, depth }) => {
          const isSelected = selectedPaths.has(entry.path)
          const isFocused = entry.path === selectedPath
          const isExpanded = entry.isDir && (isSearching || expandedPaths[entry.path])
          const isRenaming = renameDraft?.entry.path === entry.path
          const isDropTarget = dropTargetPath === entry.path
          const gitStatusKind = getEntryGitStatus(gitStatus, directoryStatus, entry)
          const gitAppearance = getGitStatusAppearance(gitStatusKind)
          const nameClassName = gitAppearance.textClass

          return (
            <div
              key={entry.path}
              ref={(node) => {
                rowRefs.current[entry.path] = node
              }}
              role="treeitem"
              data-file-explorer-row="true"
              aria-selected={isSelected}
              aria-expanded={entry.isDir ? isExpanded : undefined}
              draggable={!entry.gitDeleted && !isRenaming}
              onDragStart={(event) => handleDragStart(event, entry)}
              onDragOver={(event) => handleFolderDragOver(event, entry)}
              onDragLeave={(event) => handleFolderDragLeave(event, entry)}
              onDrop={(event) => handleFolderDrop(event, entry)}
              onDragEnd={handleDragEnd}
              onClick={(event) => {
                if (isRenaming) return
                if (completedDragSelectionRef.current) {
                  event.preventDefault()
                  return
                }
                selectEntry(entry, event)
                focusTree()
              }}
              onDoubleClick={() => {
                if (isRenaming) return
                if (entry.gitDeleted) {
                  selectOnlyEntry(entry)
                  focusTree()
                  return
                }
                void activateEntry(entry)
                focusTree()
              }}
              onContextMenu={(event) => void showContextMenu(event, entry)}
              className={`group flex min-h-[26px] cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1 text-[12px] transition-colors ${
                isDropTarget
                  ? 'bg-[color:var(--accent-primary-soft-strong)] text-[color:var(--text-strong)] ring-1 ring-[color:var(--accent-primary)]'
                  : isSelected
                  ? isFocused
                    ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
                    : 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
                  : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
              }`}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
            >
              {entry.isDir ? (
                <>
                  <ChevronIcon
                    expanded={isExpanded}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      if (!isSearching && !entry.gitDeleted) void toggleDirectory(entry)
                    }}
                  />
                  <FolderIcon expanded={isExpanded} />
                  {isRenaming ? (
                    renderRenameInput(
                      'h-5 min-w-0 flex-1 rounded-[4px] border border-[color:var(--color-6)] bg-[color:var(--bg-app)] px-1.5 text-[12px] font-medium text-[color:var(--text-strong)] outline-none focus:border-[color:var(--accent-primary)]'
                    )
                  ) : (
                    <span className={`truncate font-medium ${nameClassName}`}>{entry.name}</span>
                  )}
                  {gitAppearance.badge && (
                    <span className="ml-auto shrink-0 font-mono text-[10px] font-bold text-current opacity-80">{gitAppearance.badge}</span>
                  )}
                </>
              ) : (
                <>
                  <span className="w-3 shrink-0" />
                  <FileIcon name={entry.name} />
                  {isRenaming ? (
                    renderRenameInput(
                      'h-5 min-w-0 flex-1 rounded-[4px] border border-[color:var(--color-6)] bg-[color:var(--bg-app)] px-1.5 text-[12px] text-[color:var(--text-strong)] outline-none focus:border-[color:var(--accent-primary)]'
                    )
                  ) : (
                    <span className={`truncate ${gitAppearance.textClass}`}>{entry.name}</span>
                  )}
                  {gitAppearance.badge && (
                    <span className="ml-auto shrink-0 font-mono text-[10px] font-bold text-current opacity-80">{gitAppearance.badge}</span>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

// Tree-shaped placeholder shown while the saved folder is being verified on
// disk. The staggered indents and chevron/icon/label rhythm match the resting
// tree so the check reads as a quiet load instead of a "Checking…" message.
const FILE_EXPLORER_SKELETON_ROWS: { indent: number; width: number }[] = [
  { indent: 0, width: 52 },
  { indent: 1, width: 64 },
  { indent: 1, width: 44 },
  { indent: 2, width: 58 },
  { indent: 0, width: 48 },
  { indent: 1, width: 70 },
  { indent: 1, width: 40 },
  { indent: 0, width: 56 },
]

function FileExplorerSkeleton(): JSX.Element {
  return (
    <div className="py-1">
      <span role="status" className="sr-only">
        Loading files…
      </span>
      <div aria-hidden="true">
        {FILE_EXPLORER_SKELETON_ROWS.map((row, index) => (
          <div
            key={index}
            className="flex items-center gap-1.5 py-1 pr-3"
            style={{ paddingLeft: 12 + row.indent * 14 }}
          >
            <Skeleton className="h-3.5 w-3.5 shrink-0 rounded bg-[color:var(--skeleton-shimmer-high)]" />
            <Skeleton className="h-3 rounded bg-[color:var(--skeleton-shimmer-high)]" style={{ width: `${row.width}%` }} />
          </div>
        ))}
      </div>
    </div>
  )
}

interface Props {
  workspaceId: string
  onStartFuturePlan?: (source: FuturePlanWorkspaceSource) => void
}

export default function FileExplorer({ workspaceId, onStartFuturePlan }: Props) {
  const {
    folderPath,
    folderReadyPath,
    folderMissing,
    checkingFolder,
    recheckFolder,
  } = useWorkspaceFolderStatus(workspaceId)
  const setFolderPath = useWorkspaceStore((s) => s.setFolderPath)
  const searchExcludes = useWorkspaceStore((s) => s.appSettings.searchExcludes ?? EMPTY_SEARCH_EXCLUDES)
  const activeFilePath = useWorkspaceStore(
    (s) => s.workspaces.find((workspace) => workspace.id === workspaceId)?.editorState?.activeFilePath ?? null
  )
  const [query, setQuery] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)
  const [revealToken, setRevealToken] = useState(0)
  const [createRequest, setCreateRequest] = useState<CreateEntryRequest | null>(null)
  const {
    status: gitStatus,
    directoryStatus,
    refresh: refreshGitStatus,
  } = useGitStatus(folderReadyPath)
  const canRevealActiveFile = Boolean(folderReadyPath && activeFilePath && isPathOrChild(activeFilePath, folderReadyPath))

  const handleOpen = async () => {
    const dir = await window.api.openDir()
    if (dir) {
      setFolderPath(workspaceId, dir)
      setQuery('')
    }
  }

  const handleOpenFile = async (path: string, name: string) => {
    let content = ''
    if (!isImageFile(path || name)) {
      try {
        content = await window.api.readfile(path)
      } catch {
        content = ''
      }
    }
    // Routes to the external editor pop-up or a workspace tab per the sticky
    // openFilesInExternalWindow preference.
    openFileSurface({ workspaceId, path, name, content })
  }

  const requestCreateEntry = (kind: 'file' | 'dir') => {
    setCreateRequest({ kind, token: Date.now() })
  }

  const revealActiveFile = () => {
    if (!canRevealActiveFile) return
    setQuery('')
    setRevealToken((current) => current + 1)
  }

  const rootName = folderPath?.split(/[/\\]/).filter(Boolean).pop() ?? folderPath ?? ''

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[color:var(--bg-surface)] text-[color:var(--text-default)]">
      {rootName && (
        <>
          <PanelHeader
            title={rootName}
            overflow={
              folderReadyPath ? (
                <>
                  <Tooltip content="New file" placement="bottom">
                    <IconButton aria-label="New file" onClick={() => requestCreateEntry('file')}>
                      <NewFileIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip content="New folder" placement="bottom">
                    <IconButton aria-label="New folder" onClick={() => requestCreateEntry('dir')}>
                      <NewFolderIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip content={canRevealActiveFile ? 'Reveal active file' : 'No active file to reveal'} placement="bottom">
                    <IconButton
                      aria-label="Reveal active file"
                      onClick={revealActiveFile}
                      disabled={!canRevealActiveFile}
                    >
                      <RevealActiveFileIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip content="Refresh files" placement="bottom">
                    <IconButton
                      aria-label="Refresh files"
                      onClick={() => {
                        setRefreshToken((current) => current + 1)
                        void refreshGitStatus()
                      }}
                    >
                      <RefreshFilesIcon />
                    </IconButton>
                  </Tooltip>
                </>
              ) : undefined
            }
          />

          {folderReadyPath && (
            <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2">
              <InboxSearchInput
                value={query}
                onChange={setQuery}
                ariaLabel="Search files"
                placeholder="Search files…"
              />
            </div>
          )}
        </>
      )}

      <div className="flex-1 overflow-y-auto">
        {folderReadyPath ? (
          <ExplorerTree
            workspaceId={workspaceId}
            rootPath={folderReadyPath}
            query={query}
            searchExcludes={searchExcludes}
            refreshToken={refreshToken}
            revealPath={canRevealActiveFile ? activeFilePath : null}
            revealToken={revealToken}
            createRequest={createRequest}
            gitStatus={gitStatus}
            directoryStatus={directoryStatus}
            refreshGitStatus={refreshGitStatus}
            onOpenFile={handleOpenFile}
            onStartFuturePlan={onStartFuturePlan}
          />
        ) : checkingFolder ? (
          <FileExplorerSkeleton />
        ) : folderMissing && folderPath ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center text-[color:var(--text-disabled)]">
            <p className="text-[12px]">Saved folder is missing.</p>
            <p className="max-w-full truncate font-mono text-[11px] text-[color:var(--text-muted)]">{folderPath}</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void recheckFolder()}
                className="rounded-md border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] px-3 py-1.5 text-[11px] text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)]"
              >
                Retry
              </button>
              <button
                onClick={handleOpen}
                className="rounded-md border border-[color:var(--accent-primary)]/45 bg-[color:var(--accent-primary-soft)] px-3 py-1.5 text-[11px] font-semibold text-[color:var(--accent-primary)] transition-colors hover:bg-[color:var(--accent-primary-soft-strong)]"
              >
                Relink
              </button>
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-[color:var(--text-disabled)]">
            <p className="px-4 text-center text-[12px]">No folder open</p>
            <button
              onClick={handleOpen}
              className="rounded-md border border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] px-3 py-1.5 text-[11px] text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)]"
            >
              Open Folder
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
