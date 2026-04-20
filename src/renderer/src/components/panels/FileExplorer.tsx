import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { focusOrAddEditorBesideExplorer } from '../../utils/modelRegistry'

type Entry = {
  name: string
  isDir: boolean
  path: string
  parentPath: string
}

type TreeRow = {
  entry: Entry
  depth: number
}

type ExplorerClipboard = {
  path: string
  isDir: boolean
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

function fileAppearance(name: string): { color: string; label: string } {
  if (name === 'package.json') return { color: 'text-amber-300', label: '{}' }
  const ext = name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return { color: 'text-[#7ea4dd]', label: 'TS' }
    case 'js':
    case 'jsx':
      return { color: 'text-amber-300', label: 'JS' }
    case 'java':
      return { color: 'text-[#d97b59]', label: 'JV' }
    case 'py':
      return { color: 'text-emerald-400', label: 'PY' }
    case 'rs':
      return { color: 'text-orange-400', label: 'RS' }
    case 'go':
      return { color: 'text-sky-300', label: 'GO' }
    case 'json':
      return { color: 'text-amber-300', label: '{}' }
    case 'yaml':
    case 'yml':
      return { color: 'text-yellow-300', label: 'YML' }
    case 'md':
      return { color: 'text-zinc-300', label: 'MD' }
    case 'txt':
      return { color: 'text-zinc-400', label: 'TXT' }
    case 'html':
      return { color: 'text-orange-300', label: '<>' }
    case 'css':
    case 'scss':
      return { color: 'text-sky-300', label: '#' }
    case 'sh':
    case 'bash':
      return { color: 'text-emerald-300', label: 'SH' }
    default:
      return { color: 'text-zinc-500', label: '.' }
  }
}

function FileIcon({ name }: { name: string }) {
  const { color, label } = fileAppearance(name)
  return (
    <span
      className={`inline-flex h-[16px] w-[18px] items-center justify-center font-mono text-[9px] font-bold leading-none ${color}`}
    >
      {label}
    </span>
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

async function searchFiles(rootPath: string, query: string, limit = 200): Promise<Entry[]> {
  const matches: Entry[] = []
  const lowerQuery = query.toLowerCase().trim()
  if (!lowerQuery) return matches

  const visit = async (dirPath: string): Promise<void> => {
    if (matches.length >= limit) return
    const raw = await window.api.readdir(dirPath)
    const entries = toEntries(raw, dirPath)

    for (const entry of entries) {
      if (entry.isDir) {
        await visit(entry.path)
      } else if (entry.name.toLowerCase().includes(lowerQuery) || entry.path.toLowerCase().includes(lowerQuery)) {
        matches.push(entry)
        if (matches.length >= limit) return
      }
    }
  }

  await visit(rootPath)
  return matches
}

interface ExplorerTreeProps {
  workspaceId: string
  rootPath: string
  query: string
  refreshToken: number
  onOpenFile: (path: string, name: string) => void
}

function ExplorerTree({ workspaceId, rootPath, query, refreshToken, onOpenFile }: ExplorerTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null)
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
  const refreshTimeoutRef = useRef<number | null>(null)
  const latestExpandedPathsRef = useRef<Record<string, boolean>>({})
  const latestSearchQueryRef = useRef('')
  const latestSearchingRef = useRef(false)
  const lastManualRefreshRef = useRef(refreshToken)

  const visibleRows = useMemo(
    () => flattenTree(rootEntries, 0, expandedPaths, childrenByPath),
    [rootEntries, expandedPaths, childrenByPath]
  )

  const isSearching = query.trim().length > 0
  const activeRows = isSearching
    ? searchResults.map((entry) => ({ entry, depth: 0 }))
    : visibleRows

  useEffect(() => {
    latestExpandedPathsRef.current = expandedPaths
  }, [expandedPaths])

  useEffect(() => {
    latestSearchQueryRef.current = query
    latestSearchingRef.current = isSearching
  }, [query, isSearching])

  const loadDirectory = useCallback(async (dirPath: string) => {
    const raw = await window.api.readdir(dirPath)
    const entries = toEntries(raw, dirPath)

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

  const refreshTree = useCallback(async () => {
    const expandedDirectories = Object.entries(latestExpandedPathsRef.current)
      .filter(([, expanded]) => expanded)
      .map(([dirPath]) => dirPath)

    const directories = Array.from(new Set([rootPath, ...expandedDirectories]))
    await Promise.all(
      directories.map(async (dirPath) => {
        try {
          await loadDirectory(dirPath)
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

    if (latestSearchingRef.current) {
      setSearching(true)
      try {
        setSearchResults(await searchFiles(rootPath, latestSearchQueryRef.current))
      } finally {
        setSearching(false)
      }
    }
  }, [loadDirectory, rootPath])

  const scheduleRefresh = useCallback(() => {
    if (refreshTimeoutRef.current) {
      window.clearTimeout(refreshTimeoutRef.current)
    }

    refreshTimeoutRef.current = window.setTimeout(() => {
      refreshTimeoutRef.current = null
      void refreshTree()
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
        focusOrAddEditorBesideExplorer(workspaceId)
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error))
    }
  }

  const renameEntry = async (entry: Entry) => {
    const nextName = window.prompt('Rename', entry.name)?.trim()
    if (!nextName || nextName === entry.name) return

    try {
      const nextPath = await window.api.renamePath(entry.path, nextName)
      remapOpenFiles(workspaceId, entry.path, nextPath)

      if (entry.isDir) {
        setChildrenByPath((current) => remapChildrenByPath(current, entry.path, nextPath))
        setExpandedPaths((current) => remapExpandedPaths(current, entry.path, nextPath))
      }

      await refreshParentDirectory(entry.parentPath)
      setSelectedPath(nextPath)
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error))
    }
  }

  const pasteIntoDirectory = async (targetDir: string) => {
    if (!clipboard) return

    try {
      const newPath = await window.api.copyPath(clipboard.path, targetDir)
      setExpandedPaths((current) => ({ ...current, [targetDir]: true }))
      await refreshParentDirectory(targetDir)
      setSelectedPath(newPath)
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
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error))
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
    const canDeletePath = typeof window.api.deletePath === 'function'
    const command = await window.api.showContextMenu([
      ...(entry && !entry.isDir ? [{ id: 'open', label: 'Open' }] : []),
      ...(entry?.isDir && !isSearching
        ? [{ id: expandedPaths[entry.path] ? 'collapse' : 'expand', label: expandedPaths[entry.path] ? 'Collapse' : 'Expand' }]
        : []),
      ...(entry ? [{ type: 'separator' as const }] : []),
      { id: 'new-file', label: 'New File' },
      { id: 'new-folder', label: 'New Folder' },
      { type: 'separator' as const },
      ...(entry ? [{ id: 'copy', label: 'Copy' }] : []),
      { id: 'paste', label: 'Paste', enabled: Boolean(clipboard) && !isSearching },
      ...(entry ? [{ id: 'rename', label: 'Rename' }] : []),
      ...(entry ? [{ id: 'delete', label: canDeletePath ? 'Delete' : 'Delete (restart app)', enabled: canDeletePath }] : []),
      { type: 'separator' as const },
      { id: 'refresh', label: 'Refresh' },
    ])

    if (!command) return
    if (command === 'open' && entry) return void activateEntry(entry)
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
    if (command === 'rename' && entry) return void renameEntry(entry)
    if (command === 'delete' && entry) return void deleteEntry(entry)
    if (command === 'refresh') {
      if (isSearching || targetDir === rootPath) {
        await refreshTree()
      } else {
        await refreshParentDirectory(targetDir)
      }
    }
  }

  useEffect(() => {
    setLoading(true)
    setRootEntries([])
    setChildrenByPath({})
    setExpandedPaths({})
    setSelectedPath(null)

    loadDirectory(rootPath)
      .then((entries) => {
        setSelectedPath(entries[0]?.path ?? null)
      })
      .finally(() => setLoading(false))
  }, [loadDirectory, rootPath])

  useEffect(() => {
    if (refreshToken === lastManualRefreshRef.current) return
    lastManualRefreshRef.current = refreshToken
    void refreshTree()
  }, [refreshToken, refreshTree])

  useEffect(() => {
    let cancelled = false

    if (!isSearching) {
      setSearchResults([])
      setSearching(false)
      return
    }

    setSearching(true)
    searchFiles(rootPath, query)
      .then((results) => {
        if (!cancelled) {
          setSearchResults(results)
          setSelectedPath(results[0]?.path ?? null)
        }
      })
      .finally(() => {
        if (!cancelled) setSearching(false)
      })

    return () => {
      cancelled = true
    }
  }, [rootPath, query, isSearching])

  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => Promise<void>) | undefined

    window.api.watchPath(rootPath, () => {
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

  if (loading) {
    return <div className="px-4 py-2 text-[11px] text-zinc-600">Loading...</div>
  }

  if (isSearching && searching) {
    return <div className="px-4 py-2 text-[11px] text-zinc-600">Searching...</div>
  }

  if (isSearching && activeRows.length === 0) {
    return <div className="px-4 py-2 text-[11px] text-zinc-600">No matching files</div>
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="tree"
      onKeyDown={(event) => void handleKeyDown(event)}
      onContextMenu={(event) => void showContextMenu(event)}
      className="flex flex-col gap-px rounded-md px-1 py-1.5 outline-none focus:ring-1 focus:ring-[#2f3540]"
    >
      {activeRows.map(({ entry, depth }) => {
        const isSelected = entry.path === selectedPath
        const isExpanded = entry.isDir && expandedPaths[entry.path]
        const meta = entry.parentPath.slice(rootPath.length).replace(/^[\\/]+/, '')

        return (
          <div
            key={entry.path}
            role="treeitem"
            aria-selected={isSelected}
            aria-expanded={!isSearching && entry.isDir ? isExpanded : undefined}
            onClick={() => {
              setSelectedPath(entry.path)
              void activateEntry(entry)
              focusTree()
            }}
            onContextMenu={(event) => void showContextMenu(event, entry)}
            className={`group flex min-h-[26px] cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1 text-[12px] transition-colors ${
              isSelected
                ? 'bg-[#20252d] text-zinc-100'
                : 'text-zinc-400 hover:bg-[#17191d] hover:text-zinc-100'
            }`}
            style={{ paddingLeft: `${8 + (isSearching ? 0 : depth * 14)}px` }}
          >
            {isSearching ? (
              <>
                <span className="w-3 shrink-0" />
                <FileIcon name={entry.name} />
                <div className="min-w-0">
                  <div className="truncate">{entry.name}</div>
                  <div className="truncate text-[10px] text-zinc-600">{meta || rootPath}</div>
                </div>
              </>
            ) : entry.isDir ? (
              <>
                <span className="w-3 shrink-0 text-[10px] text-zinc-500">{isExpanded ? '▾' : '▸'}</span>
                <span className="inline-flex w-[18px] shrink-0 items-center justify-center text-[11px] font-bold leading-none text-[#d2b48c]">
                  ▢
                </span>
                <span className="truncate">{entry.name}</span>
              </>
            ) : (
              <>
                <span className="w-3 shrink-0" />
                <FileIcon name={entry.name} />
                <span className="truncate">{entry.name}</span>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

interface Props {
  workspaceId: string
}

export default function FileExplorer({ workspaceId }: Props) {
  const folderPath = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null)
  const setFolderPath = useWorkspaceStore((s) => s.setFolderPath)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const [query, setQuery] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)

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
    focusOrAddEditorBesideExplorer(workspaceId)
  }

  const rootName = folderPath?.split(/[/\\]/).filter(Boolean).pop() ?? ''

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#121316] text-zinc-300">
      <div className="border-b border-[#23262d] bg-[#14161a]">
        <div className="flex h-9 shrink-0 items-center justify-between px-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-500">Files</span>
            {rootName && <span className="truncate font-mono text-[11px] text-zinc-400">{rootName}</span>}
          </div>
          <div className="flex items-center gap-1.5">
            {folderPath && (
              <button
                onClick={() => setRefreshToken((current) => current + 1)}
                className="h-6 rounded-md border border-[#23262d] bg-[#17191d] px-2 text-[10px] text-zinc-400 transition-colors hover:bg-[#1c1f25] hover:text-zinc-200"
                title="Refresh files"
              >
                Refresh
              </button>
            )}
            <button
              onClick={handleOpen}
              className="h-6 rounded-md border border-[#23262d] bg-[#17191d] px-2 text-[10px] text-zinc-400 transition-colors hover:bg-[#1c1f25] hover:text-zinc-200"
            >
              Open
            </button>
          </div>
        </div>

        {folderPath && (
          <div className="px-3 pb-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search files..."
              className="h-8 w-full rounded-md border border-[#23262d] bg-[#101216] px-3 text-[12px] text-zinc-200 placeholder-zinc-600 outline-none transition-colors focus:border-[#3d4252]"
            />
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {folderPath ? (
          <ExplorerTree
            workspaceId={workspaceId}
            rootPath={folderPath}
            query={query}
            refreshToken={refreshToken}
            onOpenFile={handleOpenFile}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-600">
            <p className="px-4 text-center text-[12px]">No folder open</p>
            <button
              onClick={handleOpen}
              className="rounded-md border border-[#23262d] bg-[#17191d] px-3 py-1.5 text-[11px] text-zinc-400 transition-colors hover:bg-[#1c1f25]"
            >
              Open Folder
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
