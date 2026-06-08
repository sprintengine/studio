import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  GhostButton,
  IconButton,
  InboxSearchInput,
  InlineNotice,
  OverflowMenu,
  PanelHeader,
  PrimaryButton,
  Section,
  Select,
  Tooltip,
  useConfirmDialog,
  type SelectItem,
  type TooltipChildProps,
} from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import { renderMarkdown } from '../../utils/markdown'
import { basename } from '../../utils/paths'
import { focusOrAddFileTab, remapFileTabsForPath, removeFileTabsForPath } from '../../utils/modelRegistry'
import { setFileDropData } from '../../utils/terminalDrop'
import {
  backlogPreviewMarkdown,
  backlogRootPath,
  nextArchiveRelativePath,
  normalizeRelativePath,
  scanBacklog,
  type BacklogFilesystemAdapter,
  type BacklogItem,
  type BacklogItemKind,
  type BacklogItemStatus,
  type BacklogScanResult,
} from '../../utils/backlog'
import {
  addBacklogObjectLink,
  ensureBacklogObjectRecords,
  hydrateBacklogScanResult,
  loadBacklogObjectStore,
  moveBacklogObjectSource,
  removeBacklogObjectRecord,
  saveBacklogObjectStore,
  updateBacklogObjectMetadata,
  updateBacklogObjectStatus,
} from '../../utils/backlogObjects'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import type { BacklogItemAction, BacklogItemActionContext, WorkspacePanelProps } from '../../modules/renderer-host'

// Backlog panel (T4): read / search / filter / preview surface for plan files
// under the workspace `backlog/` folder. File mutations stay on existing
// filesystem IPC, while Sprint Engine starts route through the existing New
// Workspace plan-source flow.
//
// Follows knowledge/brand/aesthetic-north-star.md + panel-design-system.md and
// the approved T1 design notes: stripless nav-pane sibling of Files/Git/KG,
// one accent, hairline structure, earned-dot rule (readiness is a plan-file
// property rendered as glyph+text, never the runtime live-dot vocabulary).

type KindFilter = 'all' | BacklogItemKind
type StatusFilter = 'all' | BacklogItemStatus

type BacklogActions = {
  createFolder: () => void
  createPlan: () => void
  openInEditor: (item: BacklogItem) => void
  revealInFiles: (item: BacklogItem) => void
  rename: (item: BacklogItem) => void
  archive: (item: BacklogItem) => void
  remove: (item: BacklogItem) => void
}

const KIND_LABEL: Record<BacklogItemKind, string> = {
  product_plan: 'Product plan',
  architect_plan: 'Architect plan',
  html_mockup: 'HTML mockup',
  unknown: 'Unknown',
}

const READINESS_LABEL: Record<BacklogItemStatus, string> = {
  idea: 'Idea',
  needs_structure: 'Needs structure',
  ready: 'Ready',
  in_progress: 'In progress',
  completed: 'Completed',
  archived: 'Archived',
}

const KIND_FILTER_ITEMS: SelectItem<KindFilter>[] = [
  { value: 'all', label: 'All kinds' },
  { value: 'product_plan', label: KIND_LABEL.product_plan },
  { value: 'architect_plan', label: KIND_LABEL.architect_plan },
  { value: 'html_mockup', label: KIND_LABEL.html_mockup },
  { value: 'unknown', label: KIND_LABEL.unknown },
]

const STATUS_FILTER_ITEMS: SelectItem<StatusFilter>[] = [
  { value: 'all', label: 'All status' },
  { value: 'idea', label: READINESS_LABEL.idea },
  { value: 'needs_structure', label: READINESS_LABEL.needs_structure },
  { value: 'ready', label: READINESS_LABEL.ready },
  { value: 'in_progress', label: READINESS_LABEL.in_progress },
  { value: 'completed', label: READINESS_LABEL.completed },
  { value: 'archived', label: READINESS_LABEL.archived },
]

// Below this content width the list + detail two-pane split would be cramped,
// so the panel collapses to a single column (list, then a full-pane detail with
// a Back affordance) per design §7.
const SPLIT_MIN_WIDTH = 600
const MARKDOWN_PREVIEW_MAX_CHARS = 2 * 1024 * 1024

export default function BacklogPanel({ workspaceId, onStartFuturePlan }: WorkspacePanelProps): JSX.Element {
  const folderPath = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.folderPath ?? null,
  )
  const openFile = useWorkspaceStore((state) => state.openFile)
  const remapOpenFiles = useWorkspaceStore((state) => state.remapOpenFiles)
  const removeOpenFilesForPath = useWorkspaceStore((state) => state.removeOpenFilesForPath)
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const dialog = useConfirmDialog()
  const now = useRelativeNow()

  const adapter = useMemo<BacklogFilesystemAdapter>(
    () => ({
      pathExists: (path) => window.api.pathExists(path),
      readdir: (path) => window.api.readdir(path),
      readfile: (path) => window.api.readfile(path),
      statPath: (path) => window.api.statPath(path),
    }),
    [],
  )

  const [scan, setScan] = useState<BacklogScanResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  // Single-column (narrow) mode: which face is showing.
  const [showDetailInSingle, setShowDetailInSingle] = useState(false)
  // Visible, actionable error from a file action (create/rename/archive/delete/
  // open/reveal). Cleared at the start of each action.
  const [actionError, setActionError] = useState<string | null>(null)

  // Guards against a stale async scan (folder switch / rapid refresh) clobbering
  // a newer result.
  const scanTokenRef = useRef(0)

  const runScan = useCallback(async (): Promise<BacklogScanResult | null> => {
    // Bump the token first so any in-flight scan for a previous folder is
    // invalidated even when the folder just became unavailable — otherwise a
    // late scan for the old workspace could repopulate stale results.
    const token = ++scanTokenRef.current
    if (!folderPath) {
      setScan(null)
      setSelectedId(null)
      setShowDetailInSingle(false)
      setLoading(false)
      return null
    }
    setLoading(true)
    try {
      const scanned = await scanBacklog(folderPath, adapter)
      let metadataError: string | null = null
      const store = await loadBacklogObjectStore(folderPath, window.api).catch((error) => {
        metadataError = error instanceof Error ? error.message : String(error)
        return null
      })
      let result = scanned
      if (store) {
        const withRecords = ensureBacklogObjectRecords(store, scanned.items)
        if (withRecords.changed) {
          await saveBacklogObjectStore(folderPath, window.api, withRecords.store)
        }
        result = hydrateBacklogScanResult(scanned, withRecords.store)
      } else if (metadataError) {
        const errors = [
          ...scanned.errors,
          { relativePath: '.multi-code/backlog/items.json', message: metadataError },
        ]
        result = scanned.items.length > 0
          ? { state: 'partial', items: scanned.items, errors }
          : { state: 'error', items: [], errors }
      }
      if (token !== scanTokenRef.current) return null
      setScan(result)
      return result
    } catch (error) {
      if (token !== scanTokenRef.current) return null
      const errorResult: BacklogScanResult = {
        state: 'error',
        items: [],
        errors: [{ relativePath: 'backlog/', message: error instanceof Error ? error.message : String(error) }],
      }
      setScan(errorResult)
      return errorResult
    } finally {
      if (token === scanTokenRef.current) setLoading(false)
    }
  }, [adapter, folderPath])

  useEffect(() => {
    void runScan()
  }, [runScan])

  const items = scan?.items ?? []

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return items.filter((item) => {
      // Archived is opt-in: hidden unless explicitly selected, so a stale
      // archived plan never reads as an active idea/ready item.
      if (statusFilter === 'archived') {
        if (item.status !== 'archived') return false
      } else if (item.status === 'archived') {
        return false
      } else if (statusFilter !== 'all' && item.status !== statusFilter) {
        return false
      }
      if (kindFilter !== 'all' && item.kind !== kindFilter) return false
      if (query && !matchesQuery(item, query)) return false
      return true
    })
  }, [items, search, kindFilter, statusFilter])

  // Keep selection valid across rescans/filters; select-by-id is preserved when
  // the item survives, otherwise selection clears.
  useEffect(() => {
    if (selectedId && !filtered.some((item) => item.id === selectedId)) {
      setSelectedId(null)
      setShowDetailInSingle(false)
    }
  }, [filtered, selectedId])

  const selected = useMemo(
    () => filtered.find((item) => item.id === selectedId) ?? null,
    [filtered, selectedId],
  )

  // Responsive split vs single-column, measured from the panel's own width.
  const rootRef = useRef<HTMLElement | null>(null)
  const [isSplit, setIsSplit] = useState(true)
  useEffect(() => {
    const node = rootRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? node.clientWidth
      setIsSplit(width >= SPLIT_MIN_WIDTH)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const selectAt = useCallback(
    (index: number) => {
      const next = filtered[index]
      if (!next) return
      setSelectedId(next.id)
    },
    [filtered],
  )

  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLUListElement>) => {
      if (isEditableTarget(event.target)) return
      const currentIndex = filtered.findIndex((item) => item.id === selectedId)
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        selectAt(currentIndex < 0 ? 0 : Math.min(currentIndex + 1, filtered.length - 1))
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        selectAt(currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0))
      } else if (event.key === 'Enter' || event.key === 'ArrowRight') {
        if (selectedId) {
          event.preventDefault()
          setShowDetailInSingle(true)
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setSelectedId(null)
      }
    },
    [filtered, selectAt, selectedId],
  )

  const handleSelectRow = useCallback((id: string) => {
    setSelectedId(id)
    setShowDetailInSingle(true)
  }, [])

  // ---- file actions (all via existing window.api fs IPC; never mutate Sprint
  // Engine state). Failures surface as a visible, actionable error and leave
  // selection consistent. ----

  const runAction = useCallback(async (fn: () => Promise<void>) => {
    setActionError(null)
    try {
      await fn()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const refreshAndSelect = useCallback(
    async (id: string | null) => {
      await runScan()
      setSelectedId(id)
      if (id) setShowDetailInSingle(true)
    },
    [runScan],
  )

  const createBacklogFolder = useCallback(
    () =>
      runAction(async () => {
        if (!folderPath) return
        await window.api.ensureDir(folderPath, 'backlog')
        await runScan()
      }),
    [folderPath, runAction, runScan],
  )

  const createPlan = useCallback(
    () =>
      runAction(async () => {
        if (!folderPath) return
        const title = (
          await dialog.prompt({
            title: 'New plan',
            inputLabel: 'Plan title',
            placeholder: 'e.g. Realtime presence',
            confirmLabel: 'Create',
            required: true,
          })
        )?.trim()
        if (!title) return
        const fileName = uniquePlanFileName(
          `${todayPrefix()}-${slugify(title)}`,
          new Set((scan?.items ?? []).map((item) => item.relativePath.toLowerCase())),
        )
        // ensureDir is idempotent; it also covers a missing backlog/ folder.
        const backlogDir = await window.api.ensureDir(folderPath, 'backlog')
        const newPath = await window.api.createFile(backlogDir, fileName)
        await window.api.writefile(newPath, `# ${title}\n`)
        await refreshAndSelect(normalizeRelativePath(`backlog/${fileName}`))
      }),
    [dialog, folderPath, refreshAndSelect, runAction, scan],
  )

  const openInEditor = useCallback(
    (item: BacklogItem) =>
      runAction(async () => {
        if (!workspaceId) return
        const name = basename(item.relativePath)
        openFile(workspaceId, item.path, name, item.sourceContent)
        focusOrAddFileTab(workspaceId, item.path, name)
      }),
    [openFile, runAction, workspaceId],
  )

  const revealInFiles = useCallback(
    (item: BacklogItem) =>
      runAction(async () => {
        await window.api.showItemInFolder(item.path)
      }),
    [runAction],
  )

  const renameItem = useCallback(
    (item: BacklogItem) =>
      runAction(async () => {
        if (!folderPath) return
        const current = basename(item.relativePath)
        const next = (
          await dialog.prompt({
            title: 'Rename plan',
            inputLabel: 'File name',
            initialValue: current,
            confirmLabel: 'Rename',
            required: true,
          })
        )?.trim()
        if (!next || next === current) return
        // renamePath stays in the same directory and rejects an existing name.
        const newPath = await window.api.renamePath(item.path, next)
        // Keep any open editor tab / open-file entry pointed at the new path.
        if (workspaceId) {
          remapOpenFiles(workspaceId, item.path, newPath)
          remapFileTabsForPath(workspaceId, item.path, newPath)
        }
        const dir = item.relativePath.slice(0, item.relativePath.lastIndexOf('/') + 1)
        const nextRelativePath = normalizeRelativePath(`${dir}${next}`)
        const store = await loadBacklogObjectStore(folderPath, window.api)
        await saveBacklogObjectStore(folderPath, window.api, moveBacklogObjectSource(store, item, nextRelativePath))
        await refreshAndSelect(nextRelativePath)
      }),
    [dialog, folderPath, refreshAndSelect, remapOpenFiles, runAction, workspaceId],
  )

  const archiveItem = useCallback(
    (item: BacklogItem) =>
      runAction(async () => {
        if (!folderPath || item.status === 'archived') return
        const archivedRel = nextArchiveRelativePath(
          item.relativePath,
          (scan?.items ?? []).filter((i) => i.status === 'archived').map((i) => i.relativePath),
        )
        const archivedName = archivedRel.slice(archivedRel.lastIndexOf('/') + 1)
        // Move the live file: re-read the current on-disk content now so a plan
        // edited after the last scan is archived faithfully rather than from the
        // stale preview snapshot. If the source can't be read, abort before
        // creating anything so archive never leaves a partial copy.
        const content = await window.api.readfile(item.path)
        // Move = write the current content into the collision-safe archived
        // target, then trash the source. createFile's wx flag guards the name.
        const archivedDir = await window.api.ensureDir(backlogRootPath(folderPath), 'archived')
        const newPath = await window.api.createFile(archivedDir, archivedName)
        try {
          await window.api.writefile(newPath, content)
          await window.api.deletePath(item.path)
        } catch (error) {
          // Partial failure (write or trash failed after the archived target was
          // created): clean up the archived copy so archive never silently
          // leaves a duplicate, then surface the original error. The cleanup is
          // best-effort and must not mask the failure the user needs to see.
          await window.api.deletePath(newPath).catch(() => {})
          throw error
        }
        // Archive is a move: re-point any open editor tab / open-file entry from
        // the source to the archived path so editor state never goes stale.
        if (workspaceId) {
          remapOpenFiles(workspaceId, item.path, newPath)
          remapFileTabsForPath(workspaceId, item.path, newPath)
        }
        const store = await loadBacklogObjectStore(folderPath, window.api)
        await saveBacklogObjectStore(folderPath, window.api, moveBacklogObjectSource(store, item, archivedRel))
        await refreshAndSelect(normalizeRelativePath(archivedRel))
      }),
    [folderPath, refreshAndSelect, remapOpenFiles, runAction, scan, workspaceId],
  )

  const deleteItem = useCallback(
    (item: BacklogItem) =>
      runAction(async () => {
        const confirmed = await dialog.confirm({
          title: 'Delete plan?',
          body: `“${item.title}” will be moved to the trash. This affects the file only — no Sprint Engine state changes.`,
          confirmLabel: 'Delete',
          tone: 'danger',
        })
        if (!confirmed) return
        await window.api.deletePath(item.path)
        // Close any open editor tab / open-file entry for the trashed file so it
        // does not linger as stale editor state pointing at a missing path.
        if (workspaceId) {
          removeOpenFilesForPath(workspaceId, item.path)
          removeFileTabsForPath(workspaceId, item.path)
        }
        if (folderPath) {
          const store = await loadBacklogObjectStore(folderPath, window.api)
          await saveBacklogObjectStore(folderPath, window.api, removeBacklogObjectRecord(store, item))
        }
        await runScan()
        setSelectedId(null)
        setShowDetailInSingle(false)
      }),
    [dialog, folderPath, removeOpenFilesForPath, runAction, runScan, workspaceId],
  )

  const refreshButton = (
    <Tooltip content="Refresh backlog">
      <IconButton aria-label="Refresh backlog" onClick={() => void runScan()} disabled={loading || !folderPath}>
        <RefreshGlyph />
      </IconButton>
    </Tooltip>
  )

  const newPlanButton = (
    <GhostButton onClick={() => void createPlan()} disabled={!folderPath} aria-label="New backlog plan">
      <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
        <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      New plan
    </GhostButton>
  )

  const actions: BacklogActions = {
    createFolder: () => void createBacklogFolder(),
    createPlan: () => void createPlan(),
    openInEditor: (item) => void openInEditor(item),
    revealInFiles: (item) => void revealInFiles(item),
    rename: (item) => void renameItem(item),
    archive: (item) => void archiveItem(item),
    remove: (item) => void deleteItem(item),
  }

  // Partial scan: some files read but others failed. Surface the failures so a
  // dropped file never silently misleads (design §5 / north-star real-labels).
  const partialErrors = scan && scan.errors.length > 0 && items.length > 0 ? scan.errors : null

  // The header count is the visible row count. By default that is the
  // non-archived backlog (archived is opt-in); when a filter narrows the set —
  // especially the Archived view — label the scope so a bare number never reads
  // as the whole backlog (T16 AC3).
  const isFilteredView = search.trim() !== '' || kindFilter !== 'all' || statusFilter !== 'all'
  const headerScopeLabel = statusFilter === 'archived' ? 'archived' : isFilteredView ? 'filtered' : undefined

  const backlogActionContext = useCallback(
    (item: BacklogItem): BacklogItemActionContext | null => {
      if (!folderPath) return null
      return {
        workspaceId,
        workspaceRoot: folderPath,
        item,
        readSource: () => window.api.readfile(item.path),
        updateStatus: async (status) => {
          const store = await loadBacklogObjectStore(folderPath, window.api)
          await saveBacklogObjectStore(folderPath, window.api, updateBacklogObjectStatus(store, item, status))
          await runScan()
        },
        addLink: async (link) => {
          const store = await loadBacklogObjectStore(folderPath, window.api)
          await saveBacklogObjectStore(folderPath, window.api, addBacklogObjectLink(store, item, link))
          await runScan()
        },
        updateModuleMetadata: async (moduleId, value) => {
          const store = await loadBacklogObjectStore(folderPath, window.api)
          await saveBacklogObjectStore(folderPath, window.api, updateBacklogObjectMetadata(store, item, moduleId, value))
          await runScan()
        },
        startSourcePlan: onStartFuturePlan,
      }
    },
    [folderPath, onStartFuturePlan, runScan, workspaceId],
  )

  const externalActions = useMemo(() => {
    if (!selected) return []
    const context = backlogActionContext(selected)
    if (!context) return []
    return getRendererHost().getBacklogItemActions()
      .filter((action) => selectModuleEnabled(moduleOverrides, action.moduleId))
      .filter((action) => action.isVisible ? action.isVisible(context) : true)
      .map((action) => ({
        action,
        disabled: action.getState?.(context) === 'disabled',
        run: () => runAction(async () => {
          await action.run(context)
        }),
      }))
  }, [backlogActionContext, moduleOverrides, runAction, selected])

  // Hand a plan to an agent by dragging its row onto an agent terminal: emit the
  // same file-drop payload the Files tree uses, so TerminalView pastes the plan's
  // workspace-relative path into the live CLI session and the agent reads the
  // file. No backlog-specific drop path — the terminal side already owns it.
  const handleRowDragStart = useCallback(
    (event: React.DragEvent<HTMLLIElement>, item: BacklogItem) => {
      if (!folderPath) {
        event.preventDefault()
        return
      }
      setSelectedId(item.id)
      setFileDropData(event.dataTransfer, {
        version: 1,
        workspaceId,
        rootPath: folderPath,
        files: [{ path: item.path, name: basename(item.relativePath), isDir: false }],
      })
    },
    [folderPath, workspaceId],
  )

  const listPane = (
    <BacklogList
      items={filtered}
      selectedId={selectedId}
      now={now}
      onSelect={handleSelectRow}
      onKeyDown={handleListKeyDown}
      onItemDragStart={folderPath ? handleRowDragStart : undefined}
      emptyHint={listEmptyHint(scan, items.length, filtered.length, loading)}
    />
  )

  const detailPane = (
    <BacklogDetail
      scan={scan}
      loading={loading}
      folderPath={folderPath}
      selected={selected}
      now={now}
      hasItems={items.length > 0}
      externalActions={externalActions}
      showBack={!isSplit}
      onBack={() => setShowDetailInSingle(false)}
      actions={actions}
    />
  )

  return (
    <section
      ref={rootRef}
      className="flex h-full min-h-0 flex-col bg-[color:var(--bg-app)] text-[color:var(--text-default)]"
      aria-label="Backlog"
    >
      <PanelHeader
        title="Backlog"
        count={filtered.length}
        subtitle={headerScopeLabel}
        primaryAction={newPlanButton}
        overflow={refreshButton}
      />

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2">
        <div
          className="flex min-w-[8rem] flex-1 basis-[10rem]"
          onKeyDown={(event) => {
            // Esc clears the query while the search field is focused (design §8).
            if (event.key === 'Escape' && search) {
              event.stopPropagation()
              setSearch('')
            }
          }}
        >
          <InboxSearchInput
            value={search}
            onChange={setSearch}
            ariaLabel="Search backlog plans"
            placeholder="Search plans…"
            clearAriaLabel="Clear backlog search"
          />
        </div>
        <Select
          ariaLabel="Filter by kind"
          items={KIND_FILTER_ITEMS}
          value={kindFilter}
          onChange={setKindFilter}
          className="shrink-0"
        />
        <Select
          ariaLabel="Filter by status"
          items={STATUS_FILTER_ITEMS}
          value={statusFilter}
          onChange={setStatusFilter}
          className="shrink-0"
        />
      </div>

      {actionError ? (
        <div className="shrink-0 px-3 py-2">
          <InlineNotice
            tone="error"
            action={
              <button
                type="button"
                onClick={() => setActionError(null)}
                className="interactive text-[12px] font-semibold text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-strong)]"
              >
                Dismiss
              </button>
            }
          >
            {actionError}
          </InlineNotice>
        </div>
      ) : null}

      {partialErrors ? (
        <div className="shrink-0 px-3 py-2">
          <InlineNotice tone="warn">
            {partialErrors.length} {partialErrors.length === 1 ? 'plan' : 'plans'} couldn’t be read and {partialErrors.length === 1 ? 'is' : 'are'} not listed
            {': '}
            <span className="font-mono text-[12px] tabular-nums">
              {partialErrors.map((error) => error.relativePath).join(', ')}
            </span>
          </InlineNotice>
        </div>
      ) : null}

      {isSplit ? (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 w-[44%] max-w-[420px] flex-col border-r border-[color:var(--border-default)]">
            {listPane}
          </div>
          <div className="min-h-0 flex-1">{detailPane}</div>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          {showDetailInSingle && selected ? detailPane : listPane}
        </div>
      )}
    </section>
  )
}

// ---- List ------------------------------------------------------------------

function BacklogList({
  items,
  selectedId,
  now,
  onSelect,
  onKeyDown,
  onItemDragStart,
  emptyHint,
}: {
  items: BacklogItem[]
  selectedId: string | null
  now: number
  onSelect: (id: string) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLUListElement>) => void
  onItemDragStart?: (event: React.DragEvent<HTMLLIElement>, item: BacklogItem) => void
  emptyHint: string | null
}): JSX.Element {
  const listRef = useRef<HTMLUListElement | null>(null)

  // Keep the keyboard-selected row visible as j/k moves through the list.
  useEffect(() => {
    if (!selectedId) return
    const node = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  if (emptyHint) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <p className="max-w-[32ch] text-[12px] leading-relaxed text-[color:var(--text-disabled)]">{emptyHint}</p>
      </div>
    )
  }

  const activeIndex = items.findIndex((item) => item.id === selectedId)

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label="Backlog plans"
      tabIndex={0}
      onKeyDown={onKeyDown}
      // Active-descendant so screen readers announce the active plan as j/k/arrow
      // navigation moves selection while focus stays on the listbox.
      aria-activedescendant={activeIndex >= 0 ? `backlog-opt-${activeIndex}` : undefined}
      className="min-h-0 flex-1 overflow-auto py-1 outline-none focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--border-focus)]"
    >
      {items.map((item, index) => {
        const active = item.id === selectedId
        const archived = item.status === 'archived'
        return (
          <li
            key={item.id}
            id={`backlog-opt-${index}`}
            role="option"
            aria-selected={active}
            draggable={Boolean(onItemDragStart)}
            onDragStart={onItemDragStart ? (event) => onItemDragStart(event, item) : undefined}
            onClick={() => onSelect(item.id)}
            title={item.relativePath}
            className={`cursor-pointer border-l-[3px] px-3 py-1.5 transition-colors ${
              active
                ? 'border-l-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)] pl-[9px]'
                : 'border-l-transparent hover:bg-[color:var(--bg-hover)]'
            } ${archived ? 'opacity-70' : ''}`}
          >
            <div className="flex items-center gap-2">
              <Tooltip content={READINESS_LABEL[item.status]} placement="top">
                <ReadinessGlyph status={item.status} label={READINESS_LABEL[item.status]} />
              </Tooltip>
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[color:var(--text-strong)]">
                {item.title}
              </span>
            </div>
            {/* Supporting line: real excerpt (title already stripped) on the left,
                modified-time on the right. Path lives in the tooltip + detail
                pane, so the slug no longer echoes the title on every row. */}
            <div className="mt-0.5 flex items-center gap-2 pl-[22px] text-[11px]">
              <span className="min-w-0 flex-1 truncate text-[color:var(--text-disabled)]">{item.excerpt}</span>
              <span className="shrink-0 tabular-nums text-[color:var(--text-subtle)]">
                {formatRelativeMsAgo(item.modifiedAt, now) || 'unknown'}
              </span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// ---- Detail / preview ------------------------------------------------------

function BacklogDetail({
  scan,
  loading,
  folderPath,
  selected,
  now,
  hasItems,
  externalActions,
  showBack,
  onBack,
  actions,
}: {
  scan: BacklogScanResult | null
  loading: boolean
  folderPath: string | null
  selected: BacklogItem | null
  now: number
  hasItems: boolean
  externalActions: Array<{ action: BacklogItemAction; disabled: boolean; run: () => void }>
  showBack: boolean
  onBack: () => void
  actions: BacklogActions
}): JSX.Element {
  if (!folderPath) {
    return (
      <DetailState
        heading="No workspace folder"
        body="Backlog reads candidate plans from a project's backlog/ folder. Open a project folder to use it."
      />
    )
  }
  if (loading && !scan) {
    return <DetailState body="Loading backlog…" />
  }
  if (scan?.state === 'missing-folder') {
    return (
      <DetailState
        heading="No backlog folder"
        body="This workspace has no backlog/ folder yet. Create one to start collecting candidate plans."
        cta={
          <PrimaryButton onClick={actions.createFolder}>Create backlog folder</PrimaryButton>
        }
      />
    )
  }
  if (scan?.state === 'error') {
    return (
      <div className="p-4">
        <InlineNotice tone="error">
          <p className="font-medium">Couldn’t read the backlog folder.</p>
          <ul className="mt-1 space-y-0.5">
            {scan.errors.map((error) => (
              <li key={error.relativePath} className="font-mono text-[12px] tabular-nums">
                {error.relativePath}: {error.message}
              </li>
            ))}
          </ul>
        </InlineNotice>
      </div>
    )
  }
  if (scan?.state === 'empty-folder' || (!hasItems && scan?.state === 'ready')) {
    return (
      <DetailState
        heading="Backlog is empty"
        body="No plans found under backlog/. Create a new plan or drop a Markdown or HTML file in to get started."
        cta={<PrimaryButton onClick={actions.createPlan}>Create first plan</PrimaryButton>}
      />
    )
  }
  if (!selected) {
    return <DetailState body="Select a plan to preview." />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-[color:var(--border-default)] px-4 py-3">
        {showBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to list"
            className="interactive mb-2 inline-flex h-6 items-center gap-1 rounded px-1.5 text-[12px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
              <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back
          </button>
        ) : null}
        <h3 className="truncate text-[14px] font-semibold text-[color:var(--text-strong)]" title={selected.title}>
          {selected.title}
        </h3>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[color:var(--text-muted)]">
          <span className="inline-flex items-center gap-1">
            <ReadinessGlyph status={selected.status} />
            {READINESS_LABEL[selected.status]}
          </span>
          {selected.kind !== 'unknown' ? (
            <>
              <span aria-hidden="true" className="text-[color:var(--text-disabled)]">·</span>
              <span>{KIND_LABEL[selected.kind]}</span>
            </>
          ) : null}
          <span aria-hidden="true" className="text-[color:var(--text-disabled)]">·</span>
          <span className="font-mono tabular-nums" title={selected.relativePath}>{selected.relativePath}</span>
          <span aria-hidden="true" className="text-[color:var(--text-disabled)]">·</span>
          <span className="tabular-nums">{formatRelativeMsAgo(selected.modifiedAt, now) || 'unknown'}</span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {externalActions.map(({ action, disabled, run }, index) => {
            const Button = index === 0 ? PrimaryButton : GhostButton
            return (
              <Button
                key={action.id}
                onClick={run}
                disabled={disabled}
              >
                {action.label}
              </Button>
            )
          })}
          <GhostButton onClick={() => actions.openInEditor(selected)}>Open in editor</GhostButton>
          <GhostButton onClick={() => actions.revealInFiles(selected)}>Reveal in Files</GhostButton>
          <OverflowMenu
            ariaLabel="Plan actions"
            items={[
              { id: 'rename', label: 'Rename…', onSelect: () => actions.rename(selected) },
              ...(selected.status === 'archived'
                ? []
                : [{ id: 'archive', label: 'Archive', onSelect: () => actions.archive(selected) }]),
              { kind: 'separator' as const, id: 'sep' },
              { id: 'delete', label: 'Delete…', destructive: true, onSelect: () => actions.remove(selected) },
            ]}
          />
        </div>
      </header>

      {selected.links.length > 0 ? (
        <Section title="Links" level={4} inset className="shrink-0 border-b border-[color:var(--border-subtle)] pb-2">
          <div className="flex flex-wrap gap-2 px-3 text-[11px] text-[color:var(--text-muted)]">
            {selected.links.map((link) => (
              <span
                key={link.id}
                className="inline-flex max-w-full items-center gap-1 rounded-[var(--radius-sm)] border border-[color:var(--border-subtle)] px-1.5 py-0.5"
                title={link.target.path ?? link.target.url ?? link.target.id}
              >
                <span className="truncate text-[color:var(--text-default)]">{link.label}</span>
                {link.status ? (
                  <span className="shrink-0 text-[color:var(--text-subtle)]">· {link.status}</span>
                ) : null}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      <BacklogStructure content={selected.sourceContent} />

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <BacklogPreviewBody item={selected} />
      </div>
    </div>
  )
}

function DetailState({
  heading,
  body,
  cta,
}: {
  heading?: string
  body: string
  cta?: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="flex flex-col items-center gap-1">
        {heading ? <p className="text-[13px] font-medium text-[color:var(--text-default)]">{heading}</p> : null}
        <p className="max-w-[40ch] text-[12px] leading-relaxed text-[color:var(--text-disabled)]">{body}</p>
      </div>
      {cta}
    </div>
  )
}

// Readiness rationale: presence of the canonical plan sections, shown as a
// glyph+text checklist (design §5.3). Heading detection only — never executes
// or injects the source.
function BacklogStructure({ content }: { content: string }): JSX.Element | null {
  const checks = useMemo(() => deriveStructure(content), [content])
  if (checks.length === 0) return null
  return (
    <Section title="Structure" level={4} inset className="shrink-0 border-b border-[color:var(--border-subtle)] pb-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 text-[11px] text-[color:var(--text-muted)]">
        {checks.map((check) => (
          <span key={check.label} className="inline-flex items-center gap-1">
            <StructureGlyph present={check.present} />
            {check.label}
          </span>
        ))}
      </div>
    </Section>
  )
}

function BacklogPreviewBody({ item }: { item: BacklogItem }): JSX.Element {
  const isHtml = item.kind === 'html_mockup' || /\.html?$/i.test(item.relativePath)
  const isMarkdown = !isHtml && /\.md$/i.test(item.relativePath)
  const renderAsMarkdown = isMarkdown && item.sourceContent.length <= MARKDOWN_PREVIEW_MAX_CHARS

  if (renderAsMarkdown) {
    // Strip frontmatter + the leading title H1 so the body doesn't restate the
    // header title at display size or render raw YAML (parity with the row's
    // title-stripped excerpt).
    const body = backlogPreviewMarkdown(item.sourceContent)
    if (!body) {
      return <p className="text-[12px] text-[color:var(--text-disabled)]">No description beyond the title yet.</p>
    }
    return <div className="markdown-body">{renderMarkdown(body)}</div>
  }
  // HTML/mockup and oversized markdown render as preformatted source — never
  // inject arbitrary HTML into the renderer (design §5 / renderer-safety rule).
  return (
    <>
      {isHtml ? (
        <p className="mb-2 text-[11px] text-[color:var(--text-subtle)]">HTML source preview (not rendered).</p>
      ) : null}
      <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-5 text-[color:var(--text-default)]">
        {item.sourceContent}
      </pre>
    </>
  )
}

// ---- helpers ---------------------------------------------------------------

function matchesQuery(item: BacklogItem, query: string): boolean {
  return (
    item.title.toLowerCase().includes(query) ||
    item.relativePath.toLowerCase().includes(query) ||
    item.excerpt.toLowerCase().includes(query)
  )
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  )
}

function todayPrefix(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// Collision-safe new-plan filename within backlog/, checked against the current
// scan's project-relative paths (createFile's `wx` flag guards the race).
function uniquePlanFileName(baseName: string, existingRelativeLower: Set<string>): string {
  let candidate = `${baseName}.md`
  let index = 2
  while (existingRelativeLower.has(`backlog/${candidate}`.toLowerCase())) {
    candidate = `${baseName}-${index}.md`
    index += 1
  }
  return candidate
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

type StructureCheck = { label: string; present: boolean }

const STRUCTURE_SECTIONS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Goal', pattern: /goal|overview|objective|summary/i },
  { label: 'Tasks', pattern: /task|implementation|architecture|plan|approach/i },
  { label: 'Verification', pattern: /verif|test|validation|acceptance/i },
  { label: 'Risks', pattern: /risk|open question|tradeoff|concern/i },
]

// Inspects markdown headings only; returns no checks for non-markdown/HTML so
// the section hides rather than reporting misleading absences.
function deriveStructure(content: string): StructureCheck[] {
  const headings = content
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
  if (headings.length === 0) return []
  return STRUCTURE_SECTIONS.map((section) => ({
    label: section.label,
    present: headings.some((heading) => section.pattern.test(heading)),
  }))
}

function listEmptyHint(
  scan: BacklogScanResult | null,
  totalItems: number,
  filteredCount: number,
  loading: boolean,
): string | null {
  if (loading && !scan) return 'Loading backlog…'
  if (!scan) return null
  if (scan.state === 'missing-folder') return 'No backlog/ folder in this workspace yet.'
  if (scan.state === 'error') {
    const error = scan.errors[0]
    return error
      ? `Couldn’t read the backlog folder: ${error.relativePath}: ${error.message}`
      : 'Couldn’t read the backlog folder.'
  }
  if (totalItems === 0) return 'Backlog is empty.'
  if (filteredCount === 0) return 'No plans match the current search and filters.'
  return null
}

// ---- glyphs (house pattern: 16-box, currentColor strokes, decorative) ------

// Status is shown icon-only on rows (Linear's status-icon model): when `label`
// is supplied the glyph carries it as its accessible name (role="img") so the
// status is never color- or glyph-only, and the row wraps it in a Tooltip for
// sighted hover discoverability. Without `label` it stays decorative — used in
// the detail header where the status word sits visibly beside it. Extra props
// (the Tooltip's hover/focus handlers + aria-describedby) forward onto the svg.
// Shapes take their meaning from Linear's status icons (backlog → dashed ring,
// triage → ring + alert, todo → ring, in-progress → pie, done → check) in the
// house 16-box stroke pattern; color reinforces shape, never carries it alone.
function ReadinessGlyph({
  status,
  label,
  ...rest
}: { status: BacklogItemStatus; label?: string } & Partial<TooltipChildProps>): JSX.Element {
  const tone =
    status === 'completed' || status === 'ready'
      ? 'text-[color:var(--tone-good)]'
      : status === 'needs_structure'
        ? 'text-[color:var(--tone-warn)]'
      : status === 'in_progress'
        ? 'text-[color:var(--accent-primary)]'
      : status === 'archived'
        ? 'text-[color:var(--text-disabled)]'
        : 'text-[color:var(--text-subtle)]'

  const a11y = label ? ({ role: 'img', 'aria-label': label } as const) : ({ 'aria-hidden': true } as const)

  // Done: a filled disc with a cut-out check. The check is drawn in --bg-app so
  // it reads as a knockout against the green disc in every theme (near-black on
  // bright green in dark, near-white on deep green in light).
  const shapes =
    status === 'completed' ? (
      <>
        <circle cx="8" cy="8" r="5.25" fill="currentColor" />
        <path
          d="M5.5 8.2l1.7 1.7 3.4-3.9"
          className="[stroke:var(--bg-app)]"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ) : (
      <>
        <circle
          cx="8"
          cy="8"
          r="5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeDasharray={status === 'idea' ? '2.2 2.2' : undefined}
        />
        {status === 'in_progress' ? <path d="M8 4.8a3.2 3.2 0 0 1 0 6.4z" fill="currentColor" /> : null}
        {status === 'needs_structure' ? (
          <>
            <path d="M8 5.2v3.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="8" cy="10.7" r="0.85" fill="currentColor" />
          </>
        ) : null}
        {status === 'archived' ? (
          <path d="M4.7 11.3l6.6-6.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        ) : null}
      </>
    )

  return (
    <svg viewBox="0 0 16 16" fill="none" {...a11y} {...rest} className={`icon-sm shrink-0 ${tone}`}>
      {shapes}
    </svg>
  )
}

function StructureGlyph({ present }: { present: boolean }): JSX.Element {
  if (present) {
    return (
      <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0 text-[color:var(--tone-good)]" aria-hidden="true">
        <path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0 text-[color:var(--text-disabled)]" aria-hidden="true">
      <path d="M4 8h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function RefreshGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
      <path
        d="M13 8a5 5 0 1 1-1.46-3.54M13 3.5V6h-2.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
