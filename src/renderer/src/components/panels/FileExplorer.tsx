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

type RenameDraft = {
  entry: Entry
  value: string
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
  const renameInputRef = useRef<HTMLInputElement>(null)
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
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null)
  const refreshTimeoutRef = useRef<number | null>(null)
  const committingRenameRef = useRef(false)
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

  const renamingPath = renameDraft?.entry.path ?? null

  useEffect(() => {
    if (!renamingPath) return
    window.setTimeout(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }, 0)
  }, [renamingPath])

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

      if (entry.isDir) {
        setChildrenByPath((current) => remapChildrenByPath(current, entry.path, nextPath))
        setExpandedPaths((current) => remapExpandedPaths(current, entry.path, nextPath))
      }

      await refreshParentDirectory(entry.parentPath)
      if (isSearching) {
        setSearchResults(await searchFiles(rootPath, latestSearchQueryRef.current))
      }
      setSelectedPath(nextPath)
      setRenameDraft(null)
      focusTree()
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
      ...(entry && !entry.isDir ? [{ id: 'open-in-explorer', label: 'Open in Explorer' }] : []),
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
    if (command === 'open-in-explorer' && entry && !entry.isDir) {
      try {
        await window.api.showItemInFolder(entry.path)
      } catch (error) {
        alert(error instanceof Error ? error.message : String(error))
      }
      return
    }
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
    <div
      ref={containerRef}
      tabIndex={0}
      role="tree"
      onKeyDown={(event) => void handleKeyDown(event)}
      onContextMenu={(event) => void showContextMenu(event)}
      className="flex flex-col gap-px rounded-md px-1 py-1.5 outline-none focus:ring-1 focus:ring-[#303139]"
    >
      {activeRows.map(({ entry, depth }) => {
        const isSelected = entry.path === selectedPath
        const isExpanded = entry.isDir && expandedPaths[entry.path]
        const isRenaming = renameDraft?.entry.path === entry.path
        const meta = entry.parentPath.slice(rootPath.length).replace(/^[\\/]+/, '')

        return (
          <div
            key={entry.path}
            role="treeitem"
            aria-selected={isSelected}
            aria-expanded={!isSearching && entry.isDir ? isExpanded : undefined}
            onClick={() => {
              if (isRenaming) return
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
            style={{ paddingLeft: `${8 + (isSearching ? 0 : depth * 14)}px` }}
          >
            {isSearching ? (
              <>
                <span className="w-3 shrink-0" />
                <FileIcon name={entry.name} />
                <div className="min-w-0 flex-1">
                  {isRenaming ? (
                    renderRenameInput(
                      'h-5 w-full rounded-[4px] border border-[#3a3d49] bg-[#090a0c] px-1.5 text-[12px] text-[#ececee] outline-none focus:border-[#4f6ad7]'
                    )
                  ) : (
                    <div className="truncate">{entry.name}</div>
                  )}
                  <div className="truncate text-[10px] text-[#5a5a63]">{meta || rootPath}</div>
                </div>
              </>
            ) : entry.isDir ? (
              <>
                <ChevronIcon expanded={isExpanded} />
                <FolderIcon expanded={isExpanded} />
                {isRenaming ? (
                  renderRenameInput(
                    'h-5 min-w-0 flex-1 rounded-[4px] border border-[#3a3d49] bg-[#090a0c] px-1.5 text-[12px] font-medium text-[#ececee] outline-none focus:border-[#4f6ad7]'
                  )
                ) : (
                  <span className="truncate font-medium text-[#d7d7dc] group-hover:text-[#fff7d7]">{entry.name}</span>
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
                  <span className="truncate">{entry.name}</span>
                )}
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
    <div className="flex h-full flex-col overflow-hidden bg-[#0d0e11] text-[#d7d7dc]">
      <div className="border-b border-[#1f2025] bg-[#111216]">
        <div className="flex h-9 shrink-0 items-center justify-between px-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#5a5a63]">Files</span>
            {rootName && <span className="truncate font-mono text-[11px] text-[#9a9aa2]">{rootName}</span>}
          </div>
          <div className="flex items-center gap-1.5">
            {folderPath && (
              <button
                onClick={() => setRefreshToken((current) => current + 1)}
                className="h-6 rounded-md border border-[#24252b] bg-[#15161a] px-2 text-[10px] text-[#9a9aa2] transition-colors hover:bg-[#1a1b20] hover:text-[#ececee]"
                title="Refresh files"
              >
                Refresh
              </button>
            )}
            <button
              onClick={handleOpen}
              className="h-6 rounded-md border border-[#24252b] bg-[#15161a] px-2 text-[10px] text-[#9a9aa2] transition-colors hover:bg-[#1a1b20] hover:text-[#ececee]"
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
              className="h-8 w-full rounded-md border border-[#24252b] bg-[#090a0c] px-3 text-[12px] text-[#ececee] placeholder-[#5a5a63] outline-none transition-colors focus:border-[#303139]"
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
