import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { getGitEntry, normalizePathKey, useGitStatus } from '../../hooks/useGitStatus'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { getGitStatusAppearance } from '../../utils/gitStatusAppearance'
import { focusOrAddFileTab, remapFileTabsForPath, removeFileTabsForPath } from '../../utils/modelRegistry'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import {
  createPlanSourcedSwarmWorkspace,
  PlanSourcedSwarmWorkspaceError,
} from '../../utils/swarmWorkspaceCreation'
import { slugifySwarmName } from '../../utils/swarmStateFile'

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

type MarkdownSwarmDialogError =
  | 'missing-team'
  | 'invalid-team'
  | 'missing-goal'
  | 'invalid-source'
  | 'team-exists'
  | 'read-failure'
  | 'creation-failure'

type MarkdownSwarmDraft = {
  sourcePath: string
  sourceRelativePath: string
  sourceContent: string | null
  teamName: string
  goal: string
  error: MarkdownSwarmDialogError | null
  creating: boolean
}

const markdownSwarmErrorMessage: Record<MarkdownSwarmDialogError, string> = {
  'missing-team': 'Enter a team name.',
  'invalid-team': 'Use a team name that can produce a swarm folder name.',
  'missing-goal': 'Enter a goal.',
  'invalid-source': 'Choose a markdown file in this workspace.',
  'team-exists': 'A swarm team with this name already exists.',
  'read-failure': 'Could not read the selected markdown file.',
  'creation-failure': 'Could not create the swarm workspace.',
}

function toEntries(raw: { name: string; isDir: boolean }[], parent: string): Entry[] {
  const joiner = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return raw
    .map((entry) => ({
      ...entry,
      path: `${parent}${parent.endsWith(joiner) ? '' : joiner}${entry.name}`,
      parentPath: parent,
    }))
    .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
}

function isIgnoredExplorerWatchPath(path: string | null): boolean {
  if (!path) return false

  return path
    .split(/[/\\]+/)
    .filter(Boolean)
    .some((segment) => segment === 'node_modules' || segment.startsWith('.'))
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

function fileAppearance(name: string): { accent: string; bg: string; border: string; label: string } {
  if (name === 'package.json') {
    return { accent: '#f2c45f', bg: '#2b2414', border: '#705b28', label: '{}' }
  }

  const ext = name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return { accent: '#7db3ff', bg: '#142033', border: '#29486f', label: 'TS' }
    case 'js':
    case 'jsx':
      return { accent: '#f2d36b', bg: '#2b2613', border: '#6e6023', label: 'JS' }
    case 'java':
      return { accent: '#f19974', bg: '#2d1b16', border: '#70402f', label: 'JV' }
    case 'py':
      return { accent: '#84d69b', bg: '#14291b', border: '#2c6740', label: 'PY' }
    case 'rs':
      return { accent: '#f19974', bg: '#2d1b16', border: '#70402f', label: 'RS' }
    case 'go':
      return { accent: '#7bd7ea', bg: '#10272e', border: '#286274', label: 'GO' }
    case 'json':
      return { accent: '#f2c45f', bg: '#2b2414', border: '#705b28', label: '{}' }
    case 'yaml':
    case 'yml':
      return { accent: '#f2c45f', bg: '#2b2414', border: '#705b28', label: 'YML' }
    case 'md':
      return { accent: '#cfd2dd', bg: '#1b1d24', border: '#3a3d49', label: 'MD' }
    case 'txt':
      return { accent: '#b9bcc8', bg: '#181a20', border: '#353844', label: 'TXT' }
    case 'html':
      return { accent: '#ff9f75', bg: '#2d1b16', border: '#70402f', label: '<>' }
    case 'css':
    case 'scss':
      return { accent: '#7db3ff', bg: '#142033', border: '#29486f', label: '#' }
    case 'sh':
    case 'bash':
      return { accent: '#84d69b', bg: '#14291b', border: '#2c6740', label: 'SH' }
    default:
      return { accent: '#a6abb8', bg: '#17191f', border: '#343742', label: '.' }
  }
}

function FileIcon({ name }: { name: string }) {
  const { accent, bg, border, label } = fileAppearance(name)
  return (
    <span
      className="inline-flex h-[18px] w-[20px] shrink-0 items-center justify-center rounded-[4px] border font-mono text-[8px] font-black leading-none shadow-[0_0_0_1px_rgba(0,0,0,0.2)]"
      style={{ color: accent, backgroundColor: bg, borderColor: border }}
    >
      {label}
    </span>
  )
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <span className="inline-flex h-[18px] w-3 shrink-0 items-center justify-center text-[#838896] transition-colors group-hover:text-[#d7d7dc]">
      <svg
        viewBox="0 0 12 12"
        aria-hidden="true"
        className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
        fill="none"
      >
        <path d="M4.25 2.5 7.75 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

function FolderIcon({ expanded }: { expanded: boolean }) {
  return (
    <span className="inline-flex h-[20px] w-[22px] shrink-0 items-center justify-center">
      <svg viewBox="0 0 24 20" aria-hidden="true" className="h-5 w-6 drop-shadow-[0_1px_1px_rgba(0,0,0,0.45)]">
        <path
          d="M2.5 5.8c0-1.1.9-2 2-2h5.1l1.9 2.1h8c1.1 0 2 .9 2 2v.95h-19V5.8Z"
          fill={expanded ? '#ffe18a' : '#f2c45f'}
          stroke="#7a5b18"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path
          d="M2.25 8.4h19.5l-1.45 7.25c-.22 1.06-1.15 1.85-2.23 1.85H5.93c-1.08 0-2.01-.79-2.23-1.85L2.25 8.4Z"
          fill={expanded ? '#f4b94f' : '#d9992f'}
          stroke="#7a5b18"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path d="M5.5 10.35h13" stroke="#ffe7a5" strokeWidth="1.15" strokeLinecap="round" opacity="0.7" />
      </svg>
    </span>
  )
}

function RefreshFilesIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
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
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
      <circle cx="8" cy="8" r="4.75" stroke="currentColor" strokeWidth="1.35" />
      <circle cx="8" cy="8" r="1.45" fill="currentColor" />
      <path d="M8 1.75v2M8 12.25v2M14.25 8h-2M3.75 8h-2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  )
}

function NewFileIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
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
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
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

function pathSeparatorFor(path: string): '\\' | '/' {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
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

function swarmSlugCandidate(teamName: string): string {
  return teamName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
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
}: ExplorerTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const openFile = useWorkspaceStore((s) => s.openFile)
  const remapOpenFiles = useWorkspaceStore((s) => s.remapOpenFiles)
  const removeOpenFilesForPath = useWorkspaceStore((s) => s.removeOpenFilesForPath)

  const [rootEntries, setRootEntries] = useState<Entry[]>([])
  const [childrenByPath, setChildrenByPath] = useState<Record<string, Entry[]>>({})
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({})
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [clipboard, setClipboard] = useState<ExplorerClipboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<Entry[]>([])
  const [searchDiagnostics, setSearchDiagnostics] = useState<FileSearchDiagnostics | null>(null)
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null)
  const [markdownSwarmDraft, setMarkdownSwarmDraft] = useState<MarkdownSwarmDraft | null>(null)
  const refreshTimeoutRef = useRef<number | null>(null)
  const searchTimeoutRef = useRef<number | null>(null)
  const searchRequestSeqRef = useRef(0)
  const committingRenameRef = useRef(false)
  const markdownSwarmTeamInputRef = useRef<HTMLInputElement>(null)
  const latestExpandedPathsRef = useRef<Record<string, boolean>>({})
  const latestSearchQueryRef = useRef('')
  const latestSearchExcludesRef = useRef(searchExcludes)
  const latestGitStatusRef = useRef<GitStatusSnapshot | null>(gitStatus)
  const lastManualRefreshRef = useRef(refreshToken)
  const lastCreateRequestTokenRef = useRef(0)

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
  const searchDiagnosticsTitle = import.meta.env.DEV && searchDiagnostics
    ? `Search used ${searchDiagnostics.engine} in ${searchDiagnostics.elapsedMs} ms (${searchDiagnostics.resultCount}${searchDiagnostics.truncated ? '+' : ''} results)`
    : undefined

  useEffect(() => {
    latestExpandedPathsRef.current = expandedPaths
  }, [expandedPaths])

  useEffect(() => {
    latestSearchQueryRef.current = query
  }, [query])

  useEffect(() => {
    latestSearchExcludesRef.current = searchExcludes
  }, [searchExcludes])

  useEffect(() => {
    latestGitStatusRef.current = gitStatus
  }, [gitStatus])

  const renamingPath = renameDraft?.entry.path ?? null

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

  useEffect(() => {
    if (!markdownSwarmDraft) return
    window.setTimeout(() => {
      markdownSwarmTeamInputRef.current?.focus()
      markdownSwarmTeamInputRef.current?.select()
    }, 0)
  }, [markdownSwarmDraft?.sourcePath])

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
    if (!expandedPaths[entry.path]) {
      await ensureDirectoryLoaded(entry.path)
    }
    setExpandedPaths((current) => ({ ...current, [entry.path]: !current[entry.path] }))
  }

  const activateEntry = async (entry: Entry) => {
    setSelectedPath(entry.path)
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
    const name = window.prompt(kind === 'file' ? 'New file name' : 'New folder name', defaultName)?.trim()
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
      setSelectedPath(newPath)

      if (kind === 'file') {
        openFile(workspaceId, newPath, name, '')
        focusOrAddFileTab(workspaceId, newPath, name)
      }
      void refreshGitStatus()
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    if (!createRequest || createRequest.token === lastCreateRequestTokenRef.current) return
    lastCreateRequestTokenRef.current = createRequest.token
    void createEntry(rootPath, createRequest.kind)
  }, [createRequest?.token])

  const startRename = (entry: Entry) => {
    setSelectedPath(entry.path)
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
      setSelectedPath(nextPath)
      setRenameDraft(null)
      focusTree()
      void refreshGitStatus()
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error))
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
      setSelectedPath(newPath)
      void refreshGitStatus()
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error))
    }
  }

  const deleteEntry = async (entry: Entry) => {
    if (typeof window.api.deletePath !== 'function') {
      alert('Delete support is not loaded yet. Restart the app so Electron reloads the preload script.')
      return
    }

    const targetLabel = entry.isDir ? `folder "${entry.name}" and its contents` : `file "${entry.name}"`
    if (!window.confirm(`Move ${targetLabel} to Trash?`)) return

    try {
      await window.api.deletePath(entry.path)
      removeOpenFilesForPath(workspaceId, entry.path)
      removeFileTabsForPath(workspaceId, entry.path)

      setChildrenByPath((current) =>
        Object.fromEntries(Object.entries(current).filter(([path]) => !isPathOrChild(path, entry.path)))
      )
      setExpandedPaths((current) =>
        Object.fromEntries(Object.entries(current).filter(([path]) => !isPathOrChild(path, entry.path)))
      )
      setSearchResults((current) => current.filter((result) => !isPathOrChild(result.path, entry.path)))
      setClipboard((current) => current && isPathOrChild(current.path, entry.path) ? null : current)

      await refreshParentDirectory(entry.parentPath)
      setSelectedPath(isSearching ? null : entry.parentPath)
      void refreshGitStatus()
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error))
    }
  }

  const validateMarkdownSwarmDraft = (draft: MarkdownSwarmDraft): MarkdownSwarmDialogError | null => {
    if (!draft.teamName.trim()) return 'missing-team'
    if (!swarmSlugCandidate(draft.teamName)) return 'invalid-team'
    if (!draft.goal.trim()) return 'missing-goal'
    if (draft.sourceContent === null) return 'invalid-source'

    const relativePath = workspaceRelativePath(rootPath, draft.sourcePath)
    if (!relativePath || !/\.md$/i.test(relativePath)) return 'invalid-source'

    return null
  }

  const updateMarkdownSwarmTeamName = (teamName: string) => {
    setMarkdownSwarmDraft((current) => {
      if (!current) return current

      const error = !teamName.trim()
        ? 'missing-team'
        : !swarmSlugCandidate(teamName)
          ? 'invalid-team'
          : ['missing-team', 'invalid-team', 'team-exists', 'creation-failure'].includes(current.error ?? '')
            ? null
            : current.error

      return { ...current, teamName, error }
    })
  }

  const updateMarkdownSwarmGoal = (goal: string) => {
    setMarkdownSwarmDraft((current) => {
      if (!current) return current

      const error = !goal.trim()
        ? 'missing-goal'
        : ['missing-goal', 'creation-failure'].includes(current.error ?? '')
          ? null
          : current.error

      return { ...current, goal, error }
    })
  }

  const openMarkdownSwarmDialog = async (entry: Entry) => {
    const sourceRelativePath = markdownSourceRelativePath(rootPath, entry)
    if (!sourceRelativePath) {
      setMarkdownSwarmDraft({
        sourcePath: entry.path,
        sourceRelativePath: workspaceRelativePath(rootPath, entry.path) ?? entry.name,
        sourceContent: null,
        teamName: '',
        goal: '',
        error: 'invalid-source',
        creating: false,
      })
      return
    }

    const basename = planBasename(entry.name)
    const fallbackGoal = titleCasePlanName(basename)

    try {
      const sourceContent = await window.api.readfile(entry.path)
      setMarkdownSwarmDraft({
        sourcePath: entry.path,
        sourceRelativePath,
        sourceContent,
        teamName: slugifySwarmName(basename),
        goal: markdownTitle(sourceContent) ?? fallbackGoal,
        error: null,
        creating: false,
      })
    } catch {
      setMarkdownSwarmDraft({
        sourcePath: entry.path,
        sourceRelativePath,
        sourceContent: null,
        teamName: slugifySwarmName(basename),
        goal: fallbackGoal,
        error: 'read-failure',
        creating: false,
      })
    }
  }

  const closeMarkdownSwarmDialog = () => {
    setMarkdownSwarmDraft((current) => current?.creating ? current : null)
  }

  const createMarkdownSwarm = async () => {
    if (!markdownSwarmDraft || markdownSwarmDraft.creating) return

    const validationError = validateMarkdownSwarmDraft(markdownSwarmDraft)
    if (validationError) {
      setMarkdownSwarmDraft((current) => current ? { ...current, error: validationError } : current)
      return
    }

    try {
      setMarkdownSwarmDraft((current) => current ? { ...current, creating: true, error: null } : current)
      if (!(await window.api.pathExists(markdownSwarmDraft.sourcePath))) {
        throw new PlanSourcedSwarmWorkspaceError('missing-source')
      }
      await createPlanSourcedSwarmWorkspace({
        rootPath,
        teamName: markdownSwarmDraft.teamName,
        goal: markdownSwarmDraft.goal,
        sourcePath: markdownSwarmDraft.sourceRelativePath,
        sourceContent: markdownSwarmDraft.sourceContent ?? '',
        pathExists: window.api.pathExists,
      })
      setMarkdownSwarmDraft(null)
    } catch (error) {
      let nextError: MarkdownSwarmDialogError = 'creation-failure'
      if (error instanceof PlanSourcedSwarmWorkspaceError) {
        if (error.code === 'missing-team') nextError = 'missing-team'
        if (error.code === 'missing-goal') nextError = 'missing-goal'
        if (error.code === 'missing-source') nextError = 'invalid-source'
        if (error.code === 'team-exists') nextError = 'team-exists'
      }
      setMarkdownSwarmDraft((current) => current ? { ...current, creating: false, error: nextError } : current)
    }
  }

  const showContextMenu = async (event: React.MouseEvent, entry?: Entry) => {
    event.preventDefault()
    event.stopPropagation()
    focusTree()

    if (entry) {
      setSelectedPath(entry.path)
    }

    const targetDir = entry ? (entry.isDir ? entry.path : entry.parentPath) : rootPath
    const canUsePathCommands = !entry?.gitDeleted
    const canDeletePath = canUsePathCommands && typeof window.api.deletePath === 'function'
    const canCreateMarkdownSwarm = Boolean(entry && canUsePathCommands && markdownSourceRelativePath(rootPath, entry))
    const command = await window.api.showContextMenu([
      ...(entry && !entry.isDir && canUsePathCommands ? [{ id: 'open', label: 'Open' }] : []),
      ...(entry && !entry.isDir && canUsePathCommands ? [{ id: 'open-in-explorer', label: 'Open in Explorer' }] : []),
      ...(canCreateMarkdownSwarm ? [{ id: 'create-markdown-swarm', label: 'Create Swarm From This Markdown' }] : []),
      ...(entry?.isDir && !isSearching && canUsePathCommands
        ? [{ id: expandedPaths[entry.path] ? 'collapse' : 'expand', label: expandedPaths[entry.path] ? 'Collapse' : 'Expand' }]
        : []),
      ...(entry ? [{ type: 'separator' as const }] : []),
      { id: 'new-file', label: 'New File' },
      { id: 'new-folder', label: 'New Folder' },
      { type: 'separator' as const },
      ...(entry && canUsePathCommands ? [{ id: 'copy', label: 'Copy' }] : []),
      { id: 'paste', label: 'Paste', enabled: Boolean(clipboard) && !isSearching },
      ...(entry && canUsePathCommands ? [{ id: 'rename', label: 'Rename' }] : []),
      ...(entry ? [{ id: 'delete', label: canDeletePath ? 'Delete' : 'Delete (restart app)', enabled: canDeletePath }] : []),
      { type: 'separator' as const },
      { id: 'refresh', label: 'Refresh' },
    ])

    if (!command) return
    if (command === 'open' && entry) return void activateEntry(entry)
    if (command === 'open-in-explorer' && entry && !entry.isDir) {
      try {
        await window.api.showItemInFolder(entry.path)
      } catch (error) {
        alert(error instanceof Error ? error.message : String(error))
      }
      return
    }
    if (command === 'create-markdown-swarm' && entry) return void openMarkdownSwarmDialog(entry)
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
    if (command === 'delete' && entry) return void deleteEntry(entry)
    if (command === 'refresh') {
      if (isSearching || targetDir === rootPath) {
        await refreshTree('manual')
      } else {
        await refreshParentDirectory(targetDir)
      }
      await refreshGitStatus()
    }
  }

  const renderMarkdownSwarmDialog = () => {
    if (!markdownSwarmDraft) return null

    const validationError = validateMarkdownSwarmDraft(markdownSwarmDraft)
    const visibleError = markdownSwarmDraft.error ? markdownSwarmErrorMessage[markdownSwarmDraft.error] : null
    const canCreate = !markdownSwarmDraft.creating && !validationError && !markdownSwarmDraft.error

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeMarkdownSwarmDialog()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeMarkdownSwarmDialog()
          }
        }}
      >
        <form
          className="w-full max-w-[420px] overflow-hidden rounded-md border border-[#303139] bg-[#0d0e11] shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="markdown-swarm-dialog-title"
          onSubmit={(event) => {
            event.preventDefault()
            if (canCreate) void createMarkdownSwarm()
          }}
        >
          <div className="border-b border-[#1f2025] px-4 py-3">
            <h2 id="markdown-swarm-dialog-title" className="text-[13px] font-semibold text-[#ececee]">
              Create Swarm From Markdown
            </h2>
          </div>

          <div className="space-y-3 px-4 py-4">
            <label className="block space-y-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[#5a5a63]">Team Name</span>
              <input
                ref={markdownSwarmTeamInputRef}
                value={markdownSwarmDraft.teamName}
                disabled={markdownSwarmDraft.creating}
                onChange={(event) => updateMarkdownSwarmTeamName(event.target.value)}
                className="h-8 w-full rounded-md border border-[#24252b] bg-[#111216] px-3 text-[13px] text-[#ececee] outline-none transition-colors focus:border-[#303139] disabled:opacity-60"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[#5a5a63]">Goal</span>
              <input
                value={markdownSwarmDraft.goal}
                disabled={markdownSwarmDraft.creating}
                onChange={(event) => updateMarkdownSwarmGoal(event.target.value)}
                className="h-8 w-full rounded-md border border-[#24252b] bg-[#111216] px-3 text-[13px] text-[#ececee] outline-none transition-colors focus:border-[#303139] disabled:opacity-60"
              />
            </label>

            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[#5a5a63]">Source File</div>
              <div className="truncate rounded-md border border-[#1f2025] bg-[#090a0c] px-3 py-2 font-mono text-[11px] text-[#9a9aa2]">
                {markdownSwarmDraft.sourceRelativePath}
              </div>
            </div>

            {visibleError && (
              <div className="border-l border-[#ff787c] pl-3 text-[12px] leading-5 text-[#ffb3b5]">
                {visibleError}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[#1f2025] px-4 py-3">
            <button
              type="button"
              disabled={markdownSwarmDraft.creating}
              onClick={closeMarkdownSwarmDialog}
              className="rounded-md border border-[#24252b] bg-[#15161a] px-3 py-1.5 text-[12px] text-[#cfd2dd] transition-colors hover:bg-[#1a1b20] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-[#15161a]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canCreate}
              className="rounded-md border border-[#f2c45f]/45 bg-[#f2c45f]/12 px-3 py-1.5 text-[12px] font-semibold text-[#ffe18a] transition-colors hover:bg-[#f2c45f]/18 disabled:cursor-default disabled:border-[#343742] disabled:bg-[#15161a] disabled:text-[#5a5a63]"
            >
              {markdownSwarmDraft.creating ? 'Creating...' : 'Create Swarm'}
            </button>
          </div>
        </form>
      </div>
    )
  }

  useEffect(() => {
    setLoading(true)
    setRootEntries([])
    setChildrenByPath({})
    setExpandedPaths({})
    setSelectedPath(null)

    const startedAt = performance.now()
    loadDirectory(rootPath)
      .then((entries) => {
        setSelectedPath(entries[0]?.path ?? null)
        logPerfEvent('FileExplorer', 'refresh-tree', {
          cause: 'initial',
          rootPath,
          elapsedMs: Math.round(performance.now() - startedAt),
          expandedDirectoryCount: 0,
          loadedDirectoryCount: 1,
          isSearching: false,
        })
      })
      .finally(() => setLoading(false))
  }, [loadDirectory, rootPath])

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
          setSelectedPath(response.entries[0]?.path ?? null)
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
      if (!loading && !searching) setSelectedPath(null)
      return
    }

    if (!selectedPath || !activeRows.some((row) => row.entry.path === selectedPath)) {
      setSelectedPath(activeRows[0].entry.path)
    }
  }, [activeRows, loading, searching, selectedPath])

  const handleKeyDown = async (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (renameDraft) return
    if (!activeRows.length) return

    const currentIndex = Math.max(
      activeRows.findIndex((row) => row.entry.path === selectedPath),
      0
    )
    const currentEntry = activeRows[currentIndex].entry

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const nextRow = activeRows[Math.min(currentIndex + 1, activeRows.length - 1)]
      setSelectedPath(nextRow.entry.path)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      const previousRow = activeRows[Math.max(currentIndex - 1, 0)]
      setSelectedPath(previousRow.entry.path)
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
    return <div className="px-4 py-2 text-[11px] text-[#5a5a63]">Loading...</div>
  }

  if (isSearching && searching) {
    return <div className="px-4 py-2 text-[11px] text-[#5a5a63]">Searching...</div>
  }

  if (isSearching && activeRows.length === 0) {
    return <div className="px-4 py-2 text-[11px] text-[#5a5a63]">No matching files</div>
  }

  return (
    <>
      {renderMarkdownSwarmDialog()}
      <div
        ref={containerRef}
        tabIndex={0}
        role="tree"
        title={searchDiagnosticsTitle}
        onKeyDown={(event) => void handleKeyDown(event)}
        onContextMenu={(event) => void showContextMenu(event)}
        className="flex flex-col gap-px rounded-md px-1 py-1.5 outline-none focus:ring-1 focus:ring-[#303139]"
      >
        {activeRows.map(({ entry, depth }) => {
          const isSelected = entry.path === selectedPath
          const isExpanded = entry.isDir && (isSearching || expandedPaths[entry.path])
          const isRenaming = renameDraft?.entry.path === entry.path
          const gitStatusKind = getEntryGitStatus(gitStatus, directoryStatus, entry)
          const gitAppearance = getGitStatusAppearance(gitStatusKind)
          const nameClassName = gitAppearance.textClass || (entry.isDir ? 'text-[#d7d7dc] group-hover:text-[#fff7d7]' : '')

          return (
            <div
              key={entry.path}
              ref={(node) => {
                rowRefs.current[entry.path] = node
              }}
              role="treeitem"
              aria-selected={isSelected}
              aria-expanded={entry.isDir ? isExpanded : undefined}
              onClick={() => {
                if (isRenaming) return
                if (entry.gitDeleted) {
                  setSelectedPath(entry.path)
                  focusTree()
                  return
                }
                setSelectedPath(entry.path)
                void activateEntry(entry)
                focusTree()
              }}
              onContextMenu={(event) => void showContextMenu(event, entry)}
              className={`group flex min-h-[26px] cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1 text-[12px] transition-colors ${
                isSelected
                  ? 'bg-[#17181d] text-[#ececee]'
                  : 'text-[#9a9aa2] hover:bg-[#15161a] hover:text-[#ececee]'
              }`}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
            >
              {entry.isDir ? (
                <>
                  <ChevronIcon expanded={isExpanded} />
                  <FolderIcon expanded={isExpanded} />
                  {isRenaming ? (
                    renderRenameInput(
                      'h-5 min-w-0 flex-1 rounded-[4px] border border-[#3a3d49] bg-[#090a0c] px-1.5 text-[12px] font-medium text-[#ececee] outline-none focus:border-[#4f6ad7]'
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
                      'h-5 min-w-0 flex-1 rounded-[4px] border border-[#3a3d49] bg-[#090a0c] px-1.5 text-[12px] text-[#ececee] outline-none focus:border-[#4f6ad7]'
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

interface Props {
  workspaceId: string
}

export default function FileExplorer({ workspaceId }: Props) {
  const {
    folderPath,
    folderReadyPath,
    folderMissing,
    checkingFolder,
    recheckFolder,
  } = useWorkspaceFolderStatus(workspaceId)
  const setFolderPath = useWorkspaceStore((s) => s.setFolderPath)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const searchExcludes = useWorkspaceStore((s) => s.appSettings.searchExcludes ?? [])
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
    try {
      const content = await window.api.readfile(path)
      openFile(workspaceId, path, name, content)
    } catch {
      openFile(workspaceId, path, name, '')
    }
    focusOrAddFileTab(workspaceId, path, name)
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
    <div className="flex h-full flex-col overflow-hidden bg-[#0d0e11] text-[#d7d7dc]">
      {rootName && (
        <div className="border-b border-[#1f2025] bg-[#111216]">
          <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-3">
            <span className="min-w-0 truncate font-mono text-[11px] text-[#9a9aa2]" title={folderPath ?? undefined}>
              {rootName}
            </span>
            {folderReadyPath && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => requestCreateEntry('file')}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[#838896] transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] focus:outline-none focus:ring-1 focus:ring-[#303139]"
                  title="New file"
                  aria-label="New file"
                >
                  <NewFileIcon />
                </button>
                <button
                  type="button"
                  onClick={() => requestCreateEntry('dir')}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[#838896] transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] focus:outline-none focus:ring-1 focus:ring-[#303139]"
                  title="New folder"
                  aria-label="New folder"
                >
                  <NewFolderIcon />
                </button>
                <button
                  type="button"
                  onClick={revealActiveFile}
                  disabled={!canRevealActiveFile}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[#838896] transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] focus:outline-none focus:ring-1 focus:ring-[#303139] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[#838896]"
                  title={canRevealActiveFile ? 'Reveal active file' : 'No active file to reveal'}
                  aria-label="Reveal active file"
                >
                  <RevealActiveFileIcon />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRefreshToken((current) => current + 1)
                    void refreshGitStatus()
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[#838896] transition-colors hover:bg-[#1a1b20] hover:text-[#ececee] focus:outline-none focus:ring-1 focus:ring-[#303139]"
                  title="Refresh files"
                  aria-label="Refresh files"
                >
                  <RefreshFilesIcon />
                </button>
              </div>
            )}
          </div>

          {folderReadyPath && (
            <div className="px-3 pb-2">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search files..."
                className="h-8 w-full rounded-md border border-[#24252b] bg-[#090a0c] px-3 text-[12px] text-[#ececee] placeholder-[#5a5a63] outline-none transition-colors focus:border-[#303139]"
              />
            </div>
          )}
        </div>
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
          />
        ) : checkingFolder ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-[#5a5a63]">
            Checking workspace folder...
          </div>
        ) : folderMissing && folderPath ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center text-[#5a5a63]">
            <p className="text-[12px]">Saved folder is missing.</p>
            <p className="max-w-full truncate font-mono text-[11px] text-[#8a8a92]">{folderPath}</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void recheckFolder()}
                className="rounded-md border border-[#24252b] bg-[#15161a] px-3 py-1.5 text-[11px] text-[#9a9aa2] transition-colors hover:bg-[#1a1b20]"
              >
                Retry
              </button>
              <button
                onClick={handleOpen}
                className="rounded-md border border-[#6ee7d8]/45 bg-[#6ee7d8]/10 px-3 py-1.5 text-[11px] font-semibold text-[#bff7f1] transition-colors hover:bg-[#6ee7d8]/16"
              >
                Relink
              </button>
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-[#5a5a63]">
            <p className="px-4 text-center text-[12px]">No folder open</p>
            <button
              onClick={handleOpen}
              className="rounded-md border border-[#24252b] bg-[#15161a] px-3 py-1.5 text-[11px] text-[#9a9aa2] transition-colors hover:bg-[#1a1b20]"
            >
              Open Folder
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
