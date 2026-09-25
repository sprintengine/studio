import React, { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import { normalizePathKey, useGitStatus } from '../../hooks/useGitStatus'
import { getGitStatusAppearance } from '../../utils/gitStatusAppearance'
import { isPathOrChild } from '../../utils/paths'
import {
  buildPathTreeRows,
  changedFileEntries,
  flattenTree,
  getEntryGitStatus,
  mergeGitDeletedEntries,
  splitTreePath,
  type FileTreeEntry,
  type FileTreeRowModel,
} from '../../utils/fileTreeEntries'
import { useFileTreeModel } from '../../utils/fileTreeModel'
import {
  FileTreeFolderIcon,
  FileTreePinnedRow,
  FileTreeRow,
  FileTreeRows,
  type FileTreeRowsHandle,
} from '../ui/FileTree'
import {
  CollapseAllGlyph,
  EmptyState,
  FilterMenu,
  IconButton,
  InlineNotice,
  OverflowMenu,
  Spinner,
  Tooltip,
} from '../ui'
import { ContextMenu, MenuItem } from '../ui/ContextMenu'

// The editor window's file tree: where the open file lives, shown beside it.
//
// It READS and OPENS, nothing else. No rename, move, create or delete — those
// are the workspace's Files tree, which knows the workspace — and no writes to
// the workspace's remembered expanded folders, which belong to that tree. What
// this tree opens and selects is its own business and lasts as long as the
// window.
//
// It FOLLOWS the open file: switching tabs lists just the folders between the
// root and the file (the shared model reads only the ones not listed yet),
// opens them, selects the row and scrolls it to the nearest edge. Debounced, so
// flicking through tabs does not queue a reveal per tab, and cancelled when the
// next switch lands first.

/** How long a tab switch settles before the tree follows it. */
export const EDITOR_TREE_FOLLOW_DELAY_MS = 100

export type EditorTreeFilter = 'all' | 'changed'

type Props = {
  /** The folder the tree shows. Null while it is being worked out. */
  rootPath: string | null
  /** The file the window is showing. */
  activePath: string | null
  onOpenFile: (path: string, name: string) => void
  /** Escape: give the keyboard back to the editor. */
  onReturnFocus: () => void
  /** The pinned row's caption: the workspace's, or the folder's when the window worked the root out itself. */
  outsideLabel?: string
}

const FILTER_ITEMS = [
  { value: 'all', label: 'All files' },
  { value: 'changed', label: 'Changed files' },
] as const

function revealLabel(platform: string): string {
  if (platform === 'darwin') return 'Reveal in Finder'
  if (platform === 'win32') return 'Show in Explorer'
  return 'Show in file manager'
}

/** Rows below a collapsed folder are hidden; a flat list in tree order makes that one pass. */
function withoutCollapsed(rows: FileTreeRowModel[], collapsed: ReadonlySet<string>): FileTreeRowModel[] {
  if (collapsed.size === 0) return rows
  const out: FileTreeRowModel[] = []
  let hiddenBelowDepth: number | null = null
  for (const row of rows) {
    if (hiddenBelowDepth !== null) {
      if (row.depth > hiddenBelowDepth) continue
      hiddenBelowDepth = null
    }
    out.push(row)
    if (row.entry.isDir && collapsed.has(row.entry.path)) hiddenBelowDepth = row.depth
  }
  return out
}

export function EditorFileTree({
  rootPath,
  activePath,
  onOpenFile,
  onReturnFocus,
  outsideLabel = 'Outside this workspace',
}: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const rowsHandleRef = useRef<FileTreeRowsHandle>(null)
  const { model, snapshot } = useFileTreeModel(rootPath)
  const { status: gitStatus, directoryStatus } = useGitStatus(rootPath)
  const [filter, setFilter] = useState<EditorTreeFilter>('all')
  // Per root: tabs from two workspaces share the window, and switching back
  // to one should find its folders the way they were left.
  const [expandedByRoot, setExpandedByRoot] = useState<Record<string, Record<string, boolean>>>({})
  const [changedCollapsed, setChangedCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [pinnedMenu, setPinnedMenu] = useState<{ x: number; y: number } | null>(null)
  const pendingScrollPathRef = useRef<string | null>(null)

  const expanded = useMemo(() => (rootPath ? (expandedByRoot[rootPath] ?? {}) : {}), [expandedByRoot, rootPath])
  const setExpanded = useCallback(
    (update: (current: Record<string, boolean>) => Record<string, boolean>) => {
      if (!rootPath) return
      setExpandedByRoot((all) => ({ ...all, [rootPath]: update(all[rootPath] ?? {}) }))
    },
    [rootPath],
  )

  useEffect(() => {
    model?.setRepoRoot(gitStatus?.repoRoot ?? null)
  }, [model, gitStatus?.repoRoot])

  // The first listing. Later ones come from the model's own watch.
  useEffect(() => {
    if (!model) return
    void model.ensureLoaded(model.rootPath).catch(() => {
      // Reported on the snapshot as `rootError` once a refresh sees it.
      void model.refresh([model.rootPath])
    })
  }, [model])

  const outsideRoot = Boolean(activePath && rootPath && !isPathOrChild(activePath, rootPath))

  // Follow the open file.
  useEffect(() => {
    if (!model || !activePath || !rootPath) return
    if (!isPathOrChild(activePath, rootPath)) {
      setSelectedPath(null)
      return
    }
    let handle: { cancel: () => void } | null = null
    const timer = window.setTimeout(() => {
      const reveal = model.reveal(activePath)
      handle = reveal
      void reveal.done
        .then((ancestors) => {
          if (!ancestors) return
          if (ancestors.length) {
            setExpanded((current) => ({
              ...current,
              ...Object.fromEntries(ancestors.map((directory) => [directory, true])),
            }))
          }
          // The changed view synthesises its folders: the file shows if it
          // changed, and its folders must not stay folded over it.
          setChangedCollapsed((current) => {
            if (!ancestors.some((directory) => current.has(directory))) return current
            const next = new Set(current)
            for (const directory of ancestors) next.delete(directory)
            return next
          })
          setSelectedPath(activePath)
          pendingScrollPathRef.current = activePath
        })
        .catch(() => {
          // A folder on the way vanished; the tree shows what it can.
        })
    }, EDITOR_TREE_FOLLOW_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
      handle?.cancel()
    }
  }, [activePath, model, rootPath, setExpanded])

  const rows = useMemo<FileTreeRowModel[]>(() => {
    if (!rootPath) return []
    if (filter === 'changed') {
      return withoutCollapsed(buildPathTreeRows(rootPath, changedFileEntries(rootPath, gitStatus)), changedCollapsed)
    }
    return flattenTree(mergeGitDeletedEntries(snapshot.rootEntries ?? [], rootPath, gitStatus), 0, expanded, (dir) => {
      const children = snapshot.childrenByPath[dir]
      return children ? mergeGitDeletedEntries(children, dir, gitStatus) : undefined
    })
  }, [changedCollapsed, expanded, filter, gitStatus, rootPath, snapshot.childrenByPath, snapshot.rootEntries])

  useEffect(() => {
    const target = pendingScrollPathRef.current
    if (!target) return
    const index = rows.findIndex((row) => row.entry.path === target)
    if (index < 0) return
    pendingScrollPathRef.current = null
    rowsHandleRef.current?.scrollToIndex(index)
  }, [rows])

  const isExpanded = useCallback(
    (entry: FileTreeEntry) =>
      entry.isDir && (filter === 'changed' ? !changedCollapsed.has(entry.path) : expanded[entry.path] === true),
    [changedCollapsed, expanded, filter],
  )

  const setFolderOpen = useCallback(
    async (entry: FileTreeEntry, open: boolean) => {
      if (!entry.isDir) return
      if (filter === 'changed') {
        setChangedCollapsed((current) => {
          const next = new Set(current)
          if (open) next.delete(entry.path)
          else next.add(entry.path)
          return next
        })
        return
      }
      if (open) {
        try {
          await model?.ensureLoaded(entry.path)
        } catch {
          return
        }
        setExpanded((current) => ({ ...current, [entry.path]: true }))
      } else {
        setExpanded((current) =>
          Object.fromEntries(Object.entries(current).filter(([path]) => !isPathOrChild(path, entry.path))),
        )
      }
    },
    [filter, model, setExpanded],
  )

  const activate = useCallback(
    (entry: FileTreeEntry) => {
      setSelectedPath(entry.path)
      if (entry.isDir) {
        void setFolderOpen(entry, !isExpanded(entry))
        return
      }
      // A deleted file has nothing on disk to open.
      if (entry.gitDeleted) return
      onOpenFile(entry.path, entry.name)
    },
    [isExpanded, onOpenFile, setFolderOpen],
  )

  const collapseAll = useCallback(() => {
    if (filter === 'changed') {
      setChangedCollapsed(
        new Set(rows.filter((row) => row.entry.isDir && row.depth === 0).map((row) => row.entry.path)),
      )
    } else {
      setExpanded(() => ({}))
    }
    scrollRef.current?.scrollTo?.({ top: 0 })
  }, [filter, rows, setExpanded])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      // The window closes on Escape; from the tree, Escape means "back to the
      // file", and must not reach the window's handler.
      event.stopPropagation()
      onReturnFocus()
      return
    }
    if (rows.length === 0) return
    const currentIndex = Math.max(
      rows.findIndex((row) => row.entry.path === selectedPath),
      0,
    )
    const current = rows[currentIndex]
    const select = (index: number) => {
      const row = rows[Math.min(Math.max(index, 0), rows.length - 1)]
      if (!row) return
      setSelectedPath(row.entry.path)
      rowsHandleRef.current?.scrollToIndex(rows.indexOf(row))
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        select(selectedPath ? currentIndex + 1 : 0)
        return
      case 'ArrowUp':
        event.preventDefault()
        select(currentIndex - 1)
        return
      case 'Home':
        event.preventDefault()
        select(0)
        return
      case 'End':
        event.preventDefault()
        select(rows.length - 1)
        return
      case 'ArrowRight':
        event.preventDefault()
        if (!current?.entry.isDir) return
        if (!isExpanded(current.entry)) {
          void setFolderOpen(current.entry, true)
        } else if (rows[currentIndex + 1]?.entry.parentPath === current.entry.path) {
          select(currentIndex + 1)
        }
        return
      case 'ArrowLeft': {
        event.preventDefault()
        if (!current) return
        if (current.entry.isDir && isExpanded(current.entry)) {
          void setFolderOpen(current.entry, false)
          return
        }
        const parentIndex = rows.findIndex((row) => row.entry.path === current.entry.parentPath)
        if (parentIndex >= 0) select(parentIndex)
        return
      }
      case 'Enter':
        event.preventDefault()
        if (current) activate(current.entry)
        return
    }
  }

  const rootName = rootPath ? (rootPath.split(/[/\\]/).filter(Boolean).pop() ?? rootPath) : ''
  const outside = outsideRoot && activePath ? splitTreePath(activePath) : null
  const pinnedItems = activePath
    ? [
        {
          id: 'reveal',
          label: revealLabel(window.api.platform),
          onSelect: () => void window.api.showItemInFolder(activePath),
        },
        { id: 'copy-path', label: 'Copy path', onSelect: () => void window.api.clipboardWriteText(activePath) },
      ]
    : []

  const body = (() => {
    if (!rootPath) {
      return (
        <div className="flex items-center gap-2 px-3 py-2 text-micro text-[color:var(--text-muted)]">
          <Spinner size={12} />
          <span role="status">Finding the folder…</span>
        </div>
      )
    }
    if (snapshot.rootError && !snapshot.rootEntries) {
      return (
        <div className="px-2 py-2">
          <InlineNotice tone="error">This folder could not be read.</InlineNotice>
        </div>
      )
    }
    if (filter === 'all' && snapshot.rootEntries === null) {
      return (
        <div className="flex items-center gap-2 px-3 py-2 text-micro text-[color:var(--text-muted)]">
          <Spinner size={12} />
          <span role="status">Loading files…</span>
        </div>
      )
    }
    if (rows.length === 0) {
      return <EmptyState density="list" title={filter === 'changed' ? 'No changed files' : 'This folder is empty'} />
    }
    return (
      <FileTreeRows
        ref={rowsHandleRef}
        rows={rows}
        scrollParent={scrollRef}
        rowKey={(row) => row.entry.path}
        renderRow={({ entry, depth }) => {
          const appearance = getGitStatusAppearance(getEntryGitStatus(gitStatus, directoryStatus, entry))
          const ignored = snapshot.ignoredKeys.has(normalizePathKey(entry.path))
          return (
            <FileTreeRow
              id={`editor-tree-row-${encodeURIComponent(entry.path)}`}
              name={entry.name}
              isDir={entry.isDir}
              depth={depth}
              // No root row here: the band above names the root, so the first
              // level is the top of the tree.
              indentSteps={0}
              expanded={isExpanded(entry)}
              onToggleExpanded={() => {
                setSelectedPath(entry.path)
                void setFolderOpen(entry, !isExpanded(entry))
              }}
              selection={entry.path === selectedPath ? 'cursor' : null}
              ignored={ignored}
              nameClassName={appearance.textClass}
              badge={appearance.badge}
              title={entry.gitDeleted ? `${entry.name} was deleted` : undefined}
              onClick={() => {
                activate(entry)
                treeRef.current?.focus()
              }}
            />
          )
        }}
      />
    )
  })()

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One chrome band: the root it shows, and the two ways to narrow it. */}
      <div className="flex h-[36px] shrink-0 items-center gap-1 border-b border-[color:var(--border-default)] pl-2 pr-1.5">
        <Tooltip content={rootPath ?? ''} placement="bottom" wrapperClassName="flex min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2 text-meta">
            <FileTreeFolderIcon />
            <span className="truncate font-medium text-[color:var(--text-strong)]">{rootName || 'Files'}</span>
          </span>
        </Tooltip>
        <FilterMenu
          ariaLabel="Show files"
          groups={[
            {
              label: 'Show',
              items: FILTER_ITEMS,
              value: filter,
              defaultValue: 'all',
              onChange: (value) => setFilter(value === 'changed' ? 'changed' : 'all'),
            },
          ]}
        />
        <Tooltip content="Collapse all" placement="bottom">
          <IconButton size="xs" aria-label="Collapse all folders" onClick={collapseAll} disabled={!rootPath}>
            <CollapseAllGlyph />
          </IconButton>
        </Tooltip>
      </div>
      {/* Outside the scrolling tree, between the band and it: the rows scroll
          beneath nothing, and the open file's own row never scrolls away. */}
      {outside ? (
        <div className="shrink-0 px-1 pb-1">
          <FileTreePinnedRow
            label={outsideLabel}
            directory={outside.directory}
            fileName={outside.name}
            title={activePath ?? undefined}
            onContextMenu={(event) => {
              event.preventDefault()
              setPinnedMenu({ x: event.clientX, y: event.clientY })
            }}
            trailing={<OverflowMenu ariaLabel={`Actions for ${outside.name}`} items={pinnedItems} />}
          />
        </div>
      ) : null}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div
          ref={treeRef}
          role="tree"
          aria-label={rootName ? `Files in ${rootName}` : 'Files'}
          tabIndex={0}
          aria-activedescendant={
            selectedPath && rows.some((row) => row.entry.path === selectedPath)
              ? `editor-tree-row-${encodeURIComponent(selectedPath)}`
              : undefined
          }
          // Rests while the editor has the keyboard: the open file's row keeps
          // the quieter fill and no edge, and takes the full selection only
          // when the tree itself is being driven (assets/index.css,
          // "Selection tiers").
          data-selection-pane="auto"
          onKeyDown={onKeyDown}
          className="flex min-h-full flex-col px-1 py-1.5 outline-none focus-visible:focus-ring-inset"
        >
          {body}
        </div>
      </div>
      {pinnedMenu && outside ? (
        <ContextMenu
          x={pinnedMenu.x}
          y={pinnedMenu.y}
          ariaLabel={`Actions for ${outside.name}`}
          onClose={() => setPinnedMenu(null)}
        >
          {pinnedItems.map((item) => (
            <MenuItem
              key={item.id}
              onClick={() => {
                setPinnedMenu(null)
                item.onSelect()
              }}
            >
              {item.label}
            </MenuItem>
          ))}
        </ContextMenu>
      ) : null}
    </div>
  )
}
