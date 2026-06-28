import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  GhostButton,
  IconButton,
  InboxSearchInput,
  InlineNotice,
  LifecycleGlyph,
  OverflowMenu,
  PanelHeader,
  PrimaryButton,
  Section,
  Select,
  Skeleton,
  Tooltip,
  TruncatedText,
  useConfirmDialog,
  type SelectItem,
} from '../ui'
import { useShallow } from 'zustand/react/shallow'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { useSharedBacklogScan } from '../../hooks/useSharedBacklogScan'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import { renderMarkdown } from '../../utils/markdown'
import { basename } from '../../utils/paths'
import { focusOrAddFileTab, remapFileTabsForPath, removeFileTabsForPath } from '../../utils/modelRegistry'
import { sendFileDropToTerminal, setFileDropData, type FileDropPayload } from '../../utils/terminalDrop'
import { recordBacklogAgentHandoff } from '../../utils/backlogAgentHandoff'
import { consumePendingBacklogReveal, subscribeBacklogReveal } from '../../utils/backlogReveal'
import {
  backlogPreviewMarkdown,
  backlogRootPath,
  nextArchiveRelativePath,
  normalizeRelativePath,
  stableBacklogObjectId,
  type BacklogCriticality,
  type BacklogDifficulty,
  type BacklogHighlight,
  type BacklogItem,
  type BacklogItemStatus,
  type BacklogRisk,
  type BacklogScanResult,
} from '../../utils/backlog'
import { getHighlightSwatch } from '../../utils/highlight'
import { providerForBacklogLink } from '../../utils/backlogLinks'
import {
  matchWorkspaceForBacklogRunLink,
  sprintEngineRunLinkForItem,
} from '../../utils/sprintengineBacklogLinks'
import { deriveSprintEngineRunGlyph } from '../../utils/sprintengine'
import { BacklogLinksSection } from '../backlog/BacklogLinksSection'
import { BacklogFilterMenu } from '../backlog/BacklogFilterMenu'
import {
  compareBacklogItems,
  matchesBacklogView,
  resolveBacklogStripeColor,
  type BacklogGroup,
  type BacklogSort,
  type BacklogView,
} from '../../utils/backlogTriage'
import {
  epicGroupKey,
  groupItemsByEpic,
  groupedBacklogRows,
  isBacklogHeaderNavId,
  type BacklogEpicGroup,
  type BacklogGroupedRow,
} from '../../utils/backlogEpics'
import {
  BacklogItemContextMenu,
  CRITICALITY_EDIT_ITEMS,
  DIFFICULTY_EDIT_ITEMS,
  RISK_EDIT_ITEMS,
  type BacklogActions,
  type BacklogEpicChoice,
} from '../backlog/BacklogItemContextMenu'
import { BacklogCreateDialog, type BacklogDraft } from './BacklogCreateDialog'
import {
  BacklogEpicHeaderContent,
  BacklogRowContent,
  BACKLOG_STATUS_LABEL,
  backlogStatusToLifecycle,
  type BacklogRunGlyph,
} from '../backlog/BacklogRow'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import type { BacklogItemAction, BacklogItemActionContext, BacklogLinkProvider, WorkspacePanelProps } from '../../modules/renderer-host'

// Backlog panel: capture / browse / triage / start surface for the lightweight
// items (rough ideas, notes, feature sketches, imported markdown, mockups)
// under the workspace `backlog/` folder. File mutations stay on existing
// filesystem IPC; triage metadata (size / priority) is owned in the backlog
// object store (items.json), never markdown frontmatter; Sprint Engine starts
// route through the existing New Workspace plan-source flow with rough content.
//
// Follows knowledge/brand/aesthetic-north-star.md + panel-design-system.md:
// stripless nav-pane sibling of Files/Git/KG, one accent, hairline structure.
// Triage reads as Shared meta — a t-shirt size token and a shape-coded
// priority glyph+word — not as a per-row status dot. Unestimated is a calm
// neutral, never a "needs structure" warning.

// The row-level action vocabulary (BacklogActions), the size/priority choice
// lists, and the row context menu live in ../backlog/BacklogItemContextMenu so
// the panel composes them rather than hosting another ~250 lines of menu UI.

// Only states past capture earn a visible lifecycle word in the detail; rough
// pre-work states (idea / ready / the legacy needs_structure) read as plain
// "open" with no marker, so an unestimated note never looks like a defect.
const LIFECYCLE_LABEL: Partial<Record<BacklogItemStatus, string>> = {
  in_progress: 'In progress',
  needs_input: 'Needs input',
  completed: 'Completed',
  archived: 'Archived',
}

// Lenses double as filters: the named views express the difficulty/criticality
// ranges a single-value dropdown can't (XS/S, L/XL), and Archived is reached
// here rather than via a separate status control.
const VIEW_ITEMS: SelectItem<BacklogView>[] = [
  { value: 'all', label: 'All items' },
  { value: 'quick_wins', label: 'Quick wins' },
  { value: 'strategic_bets', label: 'Strategic bets' },
  { value: 'defer', label: 'Defer candidates' },
  { value: 'unestimated', label: 'Unestimated' },
  { value: 'archived', label: 'Archived' },
]

const SORT_ITEMS: SelectItem<BacklogSort>[] = [
  { value: 'best', label: 'Best' },
  { value: 'recent', label: 'Recently updated' },
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'largest', label: 'Largest first' },
  { value: 'smallest', label: 'Smallest first' },
]

// Grouping is orthogonal to view/sort: None is today's flat list, By epic nests
// items under collapsible epic headers (T9).
const GROUP_ITEMS: SelectItem<BacklogGroup>[] = [
  { value: 'none', label: 'None' },
  { value: 'by_epic', label: 'By epic' },
]

// Scope word shown next to the header count when a lens narrows the list, so a
// bare number never reads as the whole backlog.
const VIEW_SCOPE_LABEL: Partial<Record<BacklogView, string>> = {
  quick_wins: 'quick wins',
  strategic_bets: 'strategic bets',
  defer: 'defer candidates',
  unestimated: 'unestimated',
  archived: 'archived',
}

// Below this content width the list + detail two-pane split would be cramped,
// so the panel collapses to a single column (list, then a full-pane detail with
// a Back affordance) per design §7.
const SPLIT_MIN_WIDTH = 600
const MARKDOWN_PREVIEW_MAX_CHARS = 2 * 1024 * 1024

export default function BacklogPanel({ workspaceId, onStartFuturePlan }: WorkspacePanelProps): JSX.Element {
  const folderPath = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.folderPath ?? null,
  )
  // Only the Sprint Engine workspaces (mode or mounted run context), not the
  // whole workspace list, so a Backlog row linked to a Sprint Engine run can
  // read that run's live AutoRun state. Narrowed + useShallow so a projection
  // tick on an unrelated workspace — or any non-Sprint-Engine workspace change —
  // does not re-render the entire panel (and its 48 rows) every 4s. useShallow
  // compares the filtered array element-by-element against the live store
  // workspace refs: an unchanged Sprint Engine set stays referentially equal and
  // skips the render; a real run tick changes one ref and re-renders. See
  // backlog/2026-06-14-backlog-workspace-render-performance.md (Task 1).
  const sprintEngineWorkspaces = useWorkspaceStore(
    useShallow((state) =>
      state.workspaces.filter(
        (workspace) => workspace.mode === 'sprintengine' || Boolean(workspace.sprintEngineContext),
      ),
    ),
  )
  // Just this workspace's agents (the send-to-agent targets), not the whole
  // workspace array — a different narrow selector for a different consumer.
  const workspaceAgents = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.agents,
  )
  const openFile = useWorkspaceStore((state) => state.openFile)
  const remapOpenFiles = useWorkspaceStore((state) => state.remapOpenFiles)
  const removeOpenFilesForPath = useWorkspaceStore((state) => state.removeOpenFilesForPath)
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const setBacklogViewState = useWorkspaceStore((state) => state.setBacklogViewState)
  const dialog = useConfirmDialog()
  const now = useRelativeNow()

  // Snapshot the persisted Backlog view state once at mount so the lens/sort/
  // search restore immediately; selection is keyed by relativePath and resolved
  // against the scan below (the scan is usually not ready at mount).
  const initialBacklogState = useMemo(
    () => useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.backlogState ?? null,
    [workspaceId],
  )

  // Render-count diagnostics (gated by perfDiagnosticsEnabled, no-op in prod
  // unless diagnostics are on). Feeds the existing perf-event rollup so renders/
  // min is visible in the Diagnostics panel — the before/after evidence for the
  // re-render fan-out fix. See backlog item Task 0.
  const renderCountRef = useRef(0)
  useEffect(() => {
    renderCountRef.current += 1
    logPerfEvent('BacklogPanel', 'render', { count: renderCountRef.current, workspaceId })
  })

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState(() => initialBacklogState?.search ?? '')
  const [view, setView] = useState<BacklogView>(() => initialBacklogState?.view ?? 'all')
  const [sort, setSort] = useState<BacklogSort>(() => initialBacklogState?.sort ?? 'recent')
  const [group, setGroup] = useState<BacklogGroup>(() => initialBacklogState?.group ?? 'none')
  // Collapsed epic groups, keyed by epicGroupKey. Session-only (not persisted):
  // grouping itself persists, the open/closed state of each header does not.
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set())
  // Single-column (narrow) mode: which face is showing.
  const [showDetailInSingle, setShowDetailInSingle] = useState(false)
  // The structured "New item" capture dialog (title, description, type, size,
  // priority). The dialog owns its own busy/error state around submitCreate.
  const [creating, setCreating] = useState(false)
  // Visible, actionable error from a file action (create/rename/archive/delete/
  // open/reveal). Cleared at the start of each action.
  const [actionError, setActionError] = useState<string | null>(null)
  // Row context menu (right-click). Keyed by item id, not the item object, so a
  // re-scan triggered by a menu mutation (star, highlight) re-resolves the live
  // item and the open menu reflects the new state instead of a stale snapshot.
  const [rowMenu, setRowMenu] = useState<{ itemId: string; x: number; y: number } | null>(null)
  // Terminal-session liveness for the send-to-agent flyout. null = not fetched
  // yet (agents render enabled; the send core re-verifies liveness anyway);
  // fetched on every flyout open so a dead session shows as disabled.
  const [agentSessions, setAgentSessions] = useState<TerminalSessionSnapshot[] | null>(null)

  // Backlog scan data is shared across every workspace on the same project
  // folder (useSharedBacklogScan): N panels on one project run ONE scan and
  // share one result/refresh instead of each instance scanning the identical
  // folder. `runScan` keeps the name every mutation call site uses; it now
  // refreshes the shared entry, so a mutation in any panel updates every panel
  // on that folder. Per-workspace view state (search/sort/selection) is persisted
  // per workspace (see the restore + persist effects below) so a reload/restart
  // returns to the same item and lens.
  const { scan, loading, refresh: runScan } = useSharedBacklogScan(folderPath)

  // The shared store returns scan=null for a missing folder; mirror the old
  // behavior of clearing the local selection/detail view in that case.
  useEffect(() => {
    if (folderPath) return
    setSelectedId(null)
    setShowDetailInSingle(false)
  }, [folderPath])

  const items = scan?.items ?? []

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return items
      .filter((item) => {
        // The view lens owns archived visibility (its own option) and the
        // difficulty/criticality triage ranges; search narrows within it.
        if (!matchesBacklogView(item, view)) return false
        if (query && !matchesQuery(item, query)) return false
        return true
      })
      // Stable sort keeps scanBacklog's deterministic path order as the tiebreak
      // when two items share the sorted key.
      .sort((a, b) => compareBacklogItems(a, b, sort))
  }, [items, search, view, sort])

  // Epic grouping is an orthogonal axis layered over the filtered+sorted list.
  // `none` keeps the flat list untouched (groupedRows stays null → the panel
  // renders today's path); `by_epic` partitions into ordered epic/unknown/no-epic
  // groups and flattens them (headers + visible children) into the render +
  // keyboard order. Children keep the active sort because `filtered` is already
  // sorted and groupItemsByEpic preserves input order.
  const isGroupCollapsed = useCallback(
    (epicGroup: BacklogEpicGroup) => collapsedGroups.has(epicGroupKey(epicGroup)),
    [collapsedGroups],
  )
  const groupedRows = useMemo<BacklogGroupedRow[] | null>(() => {
    if (group !== 'by_epic') return null
    return groupedBacklogRows(groupItemsByEpic(filtered), isGroupCollapsed)
  }, [group, filtered, isGroupCollapsed])

  // The flattened selection order drives j/k navigation and aria-activedescendant
  // for both modes: grouped uses the header+child row order, flat is the filtered
  // list itself. navIndexById gives each selectable row its stable option index
  // (`backlog-opt-<n>`); in flat mode it equals the list index, so the rendered
  // markup is byte-identical to today.
  const navOrder = useMemo<string[]>(
    () => (groupedRows ? groupedRows.map((row) => row.navId) : filtered.map((item) => item.id)),
    [groupedRows, filtered],
  )
  const navIndexById = useMemo(() => {
    const map = new Map<string, number>()
    navOrder.forEach((id, index) => map.set(id, index))
    return map
  }, [navOrder])
  const rowByNavId = useMemo(() => {
    const map = new Map<string, BacklogGroupedRow>()
    if (groupedRows) for (const row of groupedRows) map.set(row.navId, row)
    return map
  }, [groupedRows])

  // Assignable epics for the "Move to epic" affordances: every epic concept file
  // with its slug + title, drawn from the full scan (not the filtered view) so
  // assignment is possible regardless of the active lens. Ordered like the epic
  // groups (epic `order:` then title). Reuses the T7 grouping, not a re-scan.
  const epicChoices = useMemo<BacklogEpicChoice[]>(
    () =>
      groupItemsByEpic(items)
        .filter((group) => group.kind === 'epic' && group.slug != null)
        .map((group) => ({ slug: group.slug as string, title: group.title })),
    [items],
  )

  const toggleGroupCollapsed = useCallback((epicGroup: BacklogEpicGroup) => {
    setCollapsedGroups((prev) => {
      const key = epicGroupKey(epicGroup)
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // Live run glyph per visible item, for items linked to an observable Sprint
  // Engine run. The rollup (`deriveSprintEngineRunGlyph`) is shared with the
  // workspace sidebar: a human-routed needs_input wins over everything, then
  // the AutoRun runtime. A null rollup (idle/manual runner, or workspace not
  // observable here) keeps the item's own status rendering — an in-progress
  // item spins by default.
  // Derived with useMemo (not inside the Zustand selector) so it never returns a
  // fresh map from the store snapshot.
  const runGlyphById = useMemo(() => {
    const map = new Map<string, BacklogRunGlyph>()
    if (!folderPath) return map
    for (const item of filtered) {
      const link = sprintEngineRunLinkForItem(item)
      if (!link) continue
      const workspace = matchWorkspaceForBacklogRunLink(sprintEngineWorkspaces, folderPath, link)
      if (!workspace) continue
      const liveGlyph = deriveSprintEngineRunGlyph({
        sprintEngineState: workspace.sprintEngineState,
        autoState: workspace.sprintEngineAutoState,
      })
      if (liveGlyph) map.set(item.id, liveGlyph)
    }
    return map
  }, [filtered, sprintEngineWorkspaces, folderPath])

  // Keep selection valid across rescans/filters/grouping. A real item cursor
  // survives as long as the item is still in `filtered` — a collapsed group hides
  // its row but must not drop the selection. A synthetic group-header cursor is
  // only valid while that header is still in the nav order (its group exists and
  // grouping is on), so it clears when grouping turns off or the group vanishes.
  useEffect(() => {
    if (!selectedId) return
    const stillValid = isBacklogHeaderNavId(selectedId)
      ? navIndexById.has(selectedId)
      : filtered.some((item) => item.id === selectedId)
    if (!stillValid) {
      setSelectedId(null)
      setShowDetailInSingle(false)
    }
  }, [filtered, navIndexById, selectedId])

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

  // Reverse navigation from an agent terminal's Backlog glyph: select the
  // requested item. The glyph often reveals this panel cold, so resolution is
  // deferred to a `pendingReveal` that is matched once the scan loads (below),
  // rather than dropped if the scan isn't ready when the signal arrives. The
  // initial value drains the latch for a reveal dispatched before mount.
  const [pendingReveal, setPendingReveal] = useState<string | null>(() =>
    consumePendingBacklogReveal(workspaceId),
  )
  useEffect(() => {
    return subscribeBacklogReveal((detail) => {
      if (detail.workspaceId !== workspaceId) return
      consumePendingBacklogReveal(workspaceId)
      setPendingReveal(detail.relativePath)
    })
  }, [workspaceId])
  useEffect(() => {
    if (!pendingReveal) return
    const wanted = pendingReveal.replace(/\\/g, '/').toLowerCase()
    const item = items.find(
      (candidate) => candidate.relativePath.replace(/\\/g, '/').toLowerCase() === wanted,
    )
    if (item) {
      // `selected` derives from `filtered`, so reset search and the lens (to the
      // item's own view if archived, else all) to keep the row visible in the
      // list beside its detail.
      setPendingReveal(null)
      setSearch('')
      setView(item.status === 'archived' ? 'archived' : 'all')
      setSelectedId(item.id)
      setShowDetailInSingle(true)
    } else if (items.length > 0) {
      // Scan is loaded and the item isn't here (e.g. just deleted): give up
      // quietly — the panel is at least open. An empty scan keeps waiting.
      setPendingReveal(null)
    }
  }, [pendingReveal, items])

  // Restore the persisted selection once the scan resolves the relativePath to a
  // live item id. Mirrors the pendingReveal latch: an empty scan keeps waiting; a
  // loaded scan without the item gives up (deleted item -> no selection). An
  // explicit reveal always wins over a restore.
  const [restorePending, setRestorePending] = useState<string | null>(
    () => initialBacklogState?.selectedRelativePath ?? null,
  )
  useEffect(() => {
    if (restorePending == null) return
    if (pendingReveal != null) {
      setRestorePending(null)
      return
    }
    const wanted = restorePending.replace(/\\/g, '/').toLowerCase()
    const item = items.find(
      (candidate) => candidate.relativePath.replace(/\\/g, '/').toLowerCase() === wanted,
    )
    if (item) {
      setSelectedId(item.id)
      setRestorePending(null)
    } else if (items.length > 0) {
      setRestorePending(null)
    }
  }, [restorePending, pendingReveal, items])

  // Persist selection + lens + sort + search so a reload/restart restores them.
  // Debounced (search changes per keystroke; every store write re-serializes the
  // workspace registry) and gated on restorePending so we never overwrite the
  // persisted selection before it has been restored. The unmount effect flushes
  // the latest when the panel/workspace is closed; the debounce timer covers a
  // Cmd-R reload (and still fires on a layer switch, which does not unmount).
  const backlogPersistRef = useRef({
    selectedRelativePath: null as string | null,
    view,
    sort,
    group,
    search,
    restorePending,
  })
  backlogPersistRef.current = {
    selectedRelativePath: selected?.relativePath ?? null,
    view,
    sort,
    group,
    search,
    restorePending,
  }
  const persistBacklogViewState = useCallback(() => {
    const snapshot = backlogPersistRef.current
    if (snapshot.restorePending != null) return
    // Don't create a default record just by opening the panel for an untouched
    // workspace; only persist once there is something non-default to remember (or
    // a record already exists).
    const isDefault =
      !snapshot.selectedRelativePath &&
      snapshot.view === 'all' &&
      snapshot.sort === 'recent' &&
      snapshot.group === 'none' &&
      snapshot.search === ''
    const hasRecord = Boolean(
      useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.backlogState,
    )
    if (isDefault && !hasRecord) return
    setBacklogViewState(workspaceId, {
      selectedRelativePath: snapshot.selectedRelativePath,
      view: snapshot.view,
      sort: snapshot.sort,
      group: snapshot.group,
      search: snapshot.search,
    })
  }, [workspaceId, setBacklogViewState])
  useEffect(() => {
    if (restorePending != null) return
    const handle = window.setTimeout(persistBacklogViewState, 300)
    return () => window.clearTimeout(handle)
  }, [restorePending, selectedId, view, sort, group, search, persistBacklogViewState])
  useEffect(() => {
    return () => persistBacklogViewState()
  }, [persistBacklogViewState])

  // Navigation runs over the flattened nav order (header + child rows when
  // grouped, the filtered list when flat), so j/k cross group boundaries exactly
  // like a flat list.
  const selectAt = useCallback(
    (index: number) => {
      const nextId = navOrder[index]
      if (nextId == null) return
      setSelectedId(nextId)
    },
    [navOrder],
  )

  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLUListElement>) => {
      if (isEditableTarget(event.target)) return
      const currentIndex = selectedId ? navOrder.indexOf(selectedId) : -1
      const currentRow = selectedId ? rowByNavId.get(selectedId) : undefined
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        selectAt(currentIndex < 0 ? 0 : Math.min(currentIndex + 1, navOrder.length - 1))
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        selectAt(currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0))
      } else if (event.key === 'Enter' || event.key === 'ArrowRight') {
        // On a group header the primary action is collapse/expand; on a leaf it
        // opens the detail (single-column mode). Flat mode has no header rows, so
        // this stays today's "open detail" behavior.
        if (currentRow?.kind === 'header') {
          event.preventDefault()
          toggleGroupCollapsed(currentRow.group)
        } else if (selectedId) {
          event.preventDefault()
          setShowDetailInSingle(true)
        }
      } else if (event.key === 'ArrowLeft') {
        if (currentRow?.kind === 'header' && !currentRow.collapsed) {
          event.preventDefault()
          toggleGroupCollapsed(currentRow.group)
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setSelectedId(null)
      }
    },
    [navOrder, rowByNavId, selectAt, selectedId, toggleGroupCollapsed],
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

  // Opening the capture dialog is the create entry point; the actual file +
  // metadata write happens on submit so a cancelled draft never touches disk.
  const openCreate = useCallback(() => {
    if (!folderPath) return
    setActionError(null)
    setCreating(true)
  }, [folderPath])

  // Throws on failure so the dialog can show the reason in-context (and keep the
  // draft) rather than routing it to the panel notice hidden behind the modal.
  const submitCreate = useCallback(
    async (draft: BacklogDraft) => {
      const title = draft.title.trim()
      if (!folderPath || !title) return
      const fileName = uniquePlanFileName(
        `${todayPrefix()}-${slugify(title)}`,
        new Set((scan?.items ?? []).map((item) => item.relativePath.toLowerCase())),
      )
      // ensureDir is idempotent; it also covers a missing backlog/ folder.
      const backlogDir = await window.api.ensureDir(folderPath, 'backlog')
      const newPath = await window.api.createFile(backlogDir, fileName)
      const description = draft.description.trim()
      await window.api.writefile(newPath, description ? `# ${title}\n\n${description}\n` : `# ${title}\n`)
      // Persist triage + type to the object store keyed by the new path. The
      // upsert creates the record, so this is the real metadata source — no
      // markdown frontmatter and no disconnected UI state.
      const relativePath = normalizeRelativePath(`backlog/${fileName}`)
      const itemRef = {
        relativePath,
        objectId: stableBacklogObjectId(relativePath),
        status: 'idea',
      } as BacklogItem
      const triage = await window.api.updateBacklogTriage({
        workspaceRoot: folderPath,
        relativePath: itemRef.relativePath,
        difficulty: draft.difficulty === 'unset' ? null : draft.difficulty,
        criticality: draft.criticality === 'unset' ? null : draft.criticality,
      })
      assertBacklogMutation(triage)
      await refreshAndSelect(relativePath)
      setCreating(false)
    },
    [folderPath, refreshAndSelect, scan],
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
            title: 'Rename item',
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
        const moved = await window.api.moveBacklogObjectSource({
          workspaceRoot: folderPath,
          relativePath: item.relativePath,
          nextRelativePath,
        })
        assertBacklogMutation(moved)
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
        const moved = await window.api.moveBacklogObjectSource({
          workspaceRoot: folderPath,
          relativePath: item.relativePath,
          nextRelativePath: archivedRel,
        })
        assertBacklogMutation(moved)
        await refreshAndSelect(normalizeRelativePath(archivedRel))
      }),
    [folderPath, refreshAndSelect, remapOpenFiles, runAction, scan, workspaceId],
  )

  const deleteItem = useCallback(
    (item: BacklogItem) =>
      runAction(async () => {
        const confirmed = await dialog.confirm({
          title: 'Delete item?',
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
          const removed = await window.api.removeBacklogObjectRecord({
            workspaceRoot: folderPath,
            relativePath: item.relativePath,
          })
          assertBacklogMutation(removed)
        }
        await runScan()
        setSelectedId(null)
        setShowDetailInSingle(false)
      }),
    [dialog, folderPath, removeOpenFilesForPath, runAction, runScan, workspaceId],
  )

  // Triage edits persist to the backlog object store (items.json) and re-scan,
  // so size/priority are real owned metadata — never markdown frontmatter and
  // never disconnected UI state.
  const setItemTriage = useCallback(
    (
      item: BacklogItem,
      triage: {
        difficulty?: BacklogDifficulty | null
        criticality?: BacklogCriticality | null
        risk?: BacklogRisk | null
      },
    ) =>
      runAction(async () => {
        if (!folderPath) return
        const updated = await window.api.updateBacklogTriage({
          workspaceRoot: folderPath,
          relativePath: item.relativePath,
          ...triage,
        })
        assertBacklogMutation(updated)
        await runScan()
      }),
    [folderPath, runAction, runScan],
  )

  const setItemStatus = useCallback(
    (item: BacklogItem, status: BacklogItemStatus) =>
      runAction(async () => {
        if (!folderPath || item.status === status) return
        const updated = await window.api.updateBacklogStatus({
          workspaceRoot: folderPath,
          relativePath: item.relativePath,
          status,
        })
        assertBacklogMutation(updated)
        await runScan()
      }),
    [folderPath, runAction, runScan],
  )

  // Star / highlight color persist to the backlog object store (items.json)
  // via backlog:update-highlight and re-scan, same as triage — owned metadata,
  // never frontmatter, never disconnected renderer state. Visual marks only:
  // sorting and filtering never key on them.
  const setItemHighlight = useCallback(
    (item: BacklogItem, highlight: BacklogHighlight) =>
      runAction(async () => {
        if (!folderPath) return
        const updated = await window.api.updateBacklogHighlight({
          workspaceRoot: folderPath,
          relativePath: item.relativePath,
          starred: highlight.starred,
          color: highlight.color,
        })
        assertBacklogMutation(updated)
        await runScan()
      }),
    [folderPath, runAction, runScan],
  )

  // Epic membership is the child's `epic:` frontmatter only (backlog:update-epic
  // rewrites the markdown; items.json is untouched). slug assigns, null clears
  // back into the No-epic group.
  const setItemEpic = useCallback(
    (item: BacklogItem, slug: string | null) =>
      runAction(async () => {
        if (!folderPath || item.epic === (slug ?? undefined)) return
        const updated = await window.api.updateBacklogEpic({
          workspaceRoot: folderPath,
          relativePath: item.relativePath,
          epic: slug,
        })
        assertBacklogMutation(updated)
        await runScan()
      }),
    [folderPath, runAction, runScan],
  )

  // "New epic…": prompt for a title, write backlog/epics/<slug>.md via the
  // create-epic writer, then assign this item to the freshly created slug. A
  // cancelled prompt or a create failure leaves the item untouched.
  const createEpicForItem = useCallback(
    (item: BacklogItem) =>
      runAction(async () => {
        if (!folderPath) return
        const title = (
          await dialog.prompt({
            title: 'New epic',
            inputLabel: 'Epic title',
            confirmLabel: 'Create',
            required: true,
          })
        )?.trim()
        if (!title) return
        const created = await window.api.createBacklogEpic({ workspaceRoot: folderPath, title })
        if (!created.ok) throw new Error(created.message)
        const assigned = await window.api.updateBacklogEpic({
          workspaceRoot: folderPath,
          relativePath: item.relativePath,
          epic: created.slug,
        })
        assertBacklogMutation(assigned)
        await runScan()
      }),
    [dialog, folderPath, runAction, runScan],
  )

  const refreshButton = (
    <Tooltip content="Refresh backlog">
      <IconButton aria-label="Refresh backlog" onClick={() => void runScan()} disabled={loading || !folderPath}>
        <RefreshGlyph />
      </IconButton>
    </Tooltip>
  )

  const newPlanButton = (
    <GhostButton onClick={openCreate} disabled={!folderPath} aria-label="New backlog item">
      <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
        <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      New item
    </GhostButton>
  )

  const actions: BacklogActions = {
    createFolder: () => void createBacklogFolder(),
    createPlan: openCreate,
    openInEditor: (item) => void openInEditor(item),
    revealInFiles: (item) => void revealInFiles(item),
    rename: (item) => void renameItem(item),
    archive: (item) => void archiveItem(item),
    remove: (item) => void deleteItem(item),
    setStatus: (item, status) => void setItemStatus(item, status),
    setDifficulty: (item, value) => setItemTriage(item, { difficulty: value === 'unset' ? null : value }),
    setCriticality: (item, value) => setItemTriage(item, { criticality: value === 'unset' ? null : value }),
    setRisk: (item, value) => setItemTriage(item, { risk: value === 'unset' ? null : value }),
    setEpic: (item, slug) => void setItemEpic(item, slug),
    createEpic: (item) => void createEpicForItem(item),
    setHighlight: (item, highlight) => void setItemHighlight(item, highlight),
  }

  // Partial scan: some files read but others failed. Surface the failures so a
  // dropped file never silently misleads (design §5 / north-star real-labels).
  const partialErrors = scan && scan.errors.length > 0 && items.length > 0 ? scan.errors : null

  // The header count is the visible row count. By default that is the
  // non-archived backlog (archived is opt-in); when a filter narrows the set —
  // especially the Archived view — label the scope so a bare number never reads
  // as the whole backlog (T16 AC3).
  const headerScopeLabel = view !== 'all'
    ? VIEW_SCOPE_LABEL[view]
    : search.trim() !== ''
      ? 'filtered'
      : undefined

  const backlogActionContext = useCallback(
    (item: BacklogItem): BacklogItemActionContext | null => {
      if (!folderPath) return null
      return {
        workspaceId,
        workspaceRoot: folderPath,
        item,
        readSource: () => window.api.readfile(item.path),
        updateStatus: async (status) => {
          const updated = await window.api.updateBacklogStatus({
            workspaceRoot: folderPath,
            relativePath: item.relativePath,
            status,
          })
          assertBacklogMutation(updated)
          await runScan()
        },
        addLink: async (link) => {
          const updated = await window.api.addOrUpdateBacklogLink({
            workspaceRoot: folderPath,
            relativePath: item.relativePath,
            link,
          })
          assertBacklogMutation(updated)
          await runScan()
        },
        updateModuleMetadata: async (moduleId, value) => {
          const updated = await window.api.updateBacklogModuleMetadata({
            workspaceRoot: folderPath,
            relativePath: item.relativePath,
            moduleId,
            value,
          })
          assertBacklogMutation(updated)
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

  // Enabled Backlog link providers, so the detail pane can resolve and open a
  // selected item's links. Disabled modules drop out, matching the action list.
  const linkProviders = useMemo(
    () => getRendererHost().getBacklogLinkProviders((moduleId) => selectModuleEnabled(moduleOverrides, moduleId)),
    [moduleOverrides],
  )

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

  // Right-click selects the row first (Files-tree behavior) so the menu and the
  // detail pane agree about the target; in single-column mode it stays on the
  // list face so the menu doesn't open over a swapped-in detail pane.
  const handleRowContextMenu = useCallback((event: React.MouseEvent, item: BacklogItem) => {
    event.preventDefault()
    setSelectedId(item.id)
    setRowMenu({ itemId: item.id, x: event.clientX, y: event.clientY })
  }, [])

  // Agents of this workspace that own a CLI terminal session — the send-to-agent
  // targets. Liveness comes from terminalList(), fetched when the flyout opens.
  const agentTargets = useMemo(() => {
    if (!workspaceAgents) return []
    return Object.values(workspaceAgents).filter(
      (agent): agent is typeof agent & { cliSessionId: string } =>
        typeof agent.cliSessionId === 'string' && agent.cliSessionId.length > 0,
    )
  }, [workspaceAgents])

  const refreshAgentSessions = useCallback(() => {
    setAgentSessions(null)
    void window.api
      .terminalList()
      .then(setAgentSessions)
      // Leave null on failure: unknown liveness must not render live agents as
      // dead; the send core re-verifies before writing anyway.
      .catch(() => {})
  }, [])

  // Same code path as dragging a row onto an agent terminal: build the
  // FileDropPayload and let the shared send core own the liveness check, the
  // plugin-adapter skill invocation vs quoted-path decision, and the worktree rule. A dead
  // session picked from a stale list rejects and surfaces as actionError.
  const sendItemToAgent = useCallback(
    (item: BacklogItem, sessionId: string) =>
      runAction(async () => {
        if (!folderPath) return
        const payload: FileDropPayload = {
          version: 1,
          workspaceId,
          rootPath: folderPath,
          files: [{ path: item.path, name: basename(item.relativePath), isDir: false }],
        }
        const result = await sendFileDropToTerminal({ payload, sessionId, workspaceId })
        if (!result.ok) throw new Error(result.message)
        // Record the item ↔ agent link on both sides (same as the drag-drop
        // handoff). The scanned title is passed through so the agent glyph's
        // tooltip matches the panel without re-deriving from the path.
        if (result.backlog) {
          void recordBacklogAgentHandoff({
            workspaceId,
            workspaceRoot: result.backlog.workspaceRoot,
            agentId: result.backlog.agentId,
            relativePath: result.backlog.relativePath,
            title: item.title,
          })
        }
      }),
    [folderPath, runAction, workspaceId],
  )

  const menuItem = rowMenu ? filtered.find((item) => item.id === rowMenu.itemId) ?? null : null

  // A mutation that removes the item from the current view (rename, archive,
  // delete, filter change) closes the menu rather than leaving it aimed at a
  // target that no longer exists.
  useEffect(() => {
    if (rowMenu && !menuItem) setRowMenu(null)
  }, [rowMenu, menuItem])

  const listPane = (
    <BacklogList
      items={filtered}
      groupedRows={groupedRows}
      navIndexById={navIndexById}
      selectedId={selectedId}
      onSelect={handleSelectRow}
      onToggleCollapse={toggleGroupCollapsed}
      onKeyDown={handleListKeyDown}
      onItemDragStart={folderPath ? handleRowDragStart : undefined}
      onItemContextMenu={folderPath ? handleRowContextMenu : undefined}
      // First load with nothing scanned yet renders a skeleton instead of a
      // text hint; a refresh over existing items keeps the current rows visible.
      skeleton={loading && !scan}
      emptyHint={listEmptyHint(scan, items.length, filtered.length, loading)}
      now={now}
      runGlyphById={runGlyphById}
    />
  )

  const detailPane = (
    <BacklogDetail
      scan={scan}
      loading={loading}
      folderPath={folderPath}
      selected={selected}
      selectedRunGlyph={selected ? runGlyphById.get(selected.id) : undefined}
      now={now}
      hasItems={items.length > 0}
      externalActions={externalActions}
      workspaceId={workspaceId}
      linkProviders={linkProviders}
      showBack={!isSplit}
      onBack={() => setShowDetailInSingle(false)}
      actions={actions}
      epicChoices={epicChoices}
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
            ariaLabel="Search backlog items"
            placeholder="Search items…"
            clearAriaLabel="Clear backlog search"
          />
        </div>
        <BacklogFilterMenu
          view={view}
          sort={sort}
          group={group}
          viewItems={VIEW_ITEMS}
          sortItems={SORT_ITEMS}
          groupItems={GROUP_ITEMS}
          onViewChange={setView}
          onSortChange={setSort}
          onGroupChange={setGroup}
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
            {partialErrors.length} {partialErrors.length === 1 ? 'item' : 'items'} couldn’t be read and {partialErrors.length === 1 ? 'is' : 'are'} not listed
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

      {creating ? (
        <BacklogCreateDialog
          difficultyItems={DIFFICULTY_EDIT_ITEMS}
          criticalityItems={CRITICALITY_EDIT_ITEMS}
          onClose={() => setCreating(false)}
          onCreate={submitCreate}
        />
      ) : null}

      {rowMenu && menuItem ? (
        <BacklogItemContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          item={menuItem}
          actions={actions}
          epicChoices={epicChoices}
          agentTargets={agentTargets}
          agentSessions={agentSessions}
          onFlyoutOpen={refreshAgentSessions}
          onSendToAgent={(item, sessionId) => void sendItemToAgent(item, sessionId)}
          onClose={() => setRowMenu(null)}
        />
      ) : null}
    </section>
  )
}

// ---- List ------------------------------------------------------------------

// Row-shaped placeholder shown on first load before any items have scanned,
// mirroring BacklogRowContent's two-line rhythm (glyph + title on the primary
// line, a shorter supporting line indented past the glyph) so the real list
// reveals into the same shape. Widths are fixed, not random, so the placeholder
// is stable across re-renders. Decorative; one concise status label announces
// the load for screen readers.
const BACKLOG_SKELETON_ROWS: ReadonlyArray<{ title: string; meta: string }> = [
  { title: '58%', meta: '34%' },
  { title: '42%', meta: '49%' },
  { title: '66%', meta: '28%' },
  { title: '37%', meta: '40%' },
  { title: '52%', meta: '31%' },
  { title: '61%', meta: '45%' },
  { title: '44%', meta: '26%' },
]

function BacklogListSkeleton(): JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-hidden py-1">
      <span role="status" className="sr-only">
        Loading backlog…
      </span>
      <div aria-hidden="true">
        {BACKLOG_SKELETON_ROWS.map((row, index) => (
          <div key={index} className="border-l-[3px] border-l-transparent px-3 py-1.5">
            <div className="flex items-center gap-2">
              <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full bg-[color:var(--skeleton-shimmer-high)]" />
              <Skeleton
                className="h-3 rounded bg-[color:var(--skeleton-shimmer-high)]"
                style={{ width: row.title }}
              />
            </div>
            <div className="mt-1 pl-[22px]">
              <Skeleton
                className="h-2.5 rounded bg-[color:var(--skeleton-shimmer-high)]"
                style={{ width: row.meta }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function BacklogList({
  items,
  groupedRows,
  navIndexById,
  selectedId,
  onSelect,
  onToggleCollapse,
  onKeyDown,
  onItemDragStart,
  onItemContextMenu,
  skeleton,
  emptyHint,
  now,
  runGlyphById,
}: {
  items: BacklogItem[]
  // Non-null when grouping by epic: the flattened header+child render order.
  // Null keeps the flat list path (byte-identical to the ungrouped default).
  groupedRows: BacklogGroupedRow[] | null
  navIndexById: ReadonlyMap<string, number>
  selectedId: string | null
  onSelect: (id: string) => void
  onToggleCollapse: (group: BacklogEpicGroup) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLUListElement>) => void
  onItemDragStart?: (event: React.DragEvent<HTMLLIElement>, item: BacklogItem) => void
  onItemContextMenu?: (event: React.MouseEvent, item: BacklogItem) => void
  skeleton: boolean
  emptyHint: string | null
  now: number
  runGlyphById?: ReadonlyMap<string, BacklogRunGlyph>
}): JSX.Element {
  const listRef = useRef<HTMLUListElement | null>(null)

  // Keep the keyboard-selected row visible as j/k moves through the list.
  useEffect(() => {
    if (!selectedId) return
    const node = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  if (skeleton) {
    return <BacklogListSkeleton />
  }

  if (emptyHint) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <p className="max-w-[32ch] text-[12px] leading-relaxed text-[color:var(--text-disabled)]">{emptyHint}</p>
      </div>
    )
  }

  // The option index is the row's position in the flattened nav order; it equals
  // the list index in flat mode, so `backlog-opt-<n>` ids stay byte-identical.
  const activeIndex = selectedId != null ? navIndexById.get(selectedId) ?? -1 : -1

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label="Backlog items"
      tabIndex={0}
      onKeyDown={onKeyDown}
      // Active-descendant so screen readers announce the active plan as j/k/arrow
      // navigation moves selection while focus stays on the listbox.
      aria-activedescendant={activeIndex >= 0 ? `backlog-opt-${activeIndex}` : undefined}
      className="min-h-0 flex-1 overflow-auto py-1 outline-none focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--border-focus)]"
    >
      {groupedRows
        ? groupedRows.map((row) =>
            row.kind === 'header' ? (
              <BacklogGroupHeaderRow
                key={row.navId}
                row={row}
                optionIndex={navIndexById.get(row.navId) ?? -1}
                selected={row.navId === selectedId}
                onSelect={onSelect}
                onToggleCollapse={onToggleCollapse}
                onItemDragStart={onItemDragStart}
                onItemContextMenu={onItemContextMenu}
              />
            ) : (
              <BacklogOptionRow
                key={row.item.id}
                item={row.item}
                optionIndex={navIndexById.get(row.item.id) ?? -1}
                selected={row.item.id === selectedId}
                indented
                onSelect={onSelect}
                onItemDragStart={onItemDragStart}
                onItemContextMenu={onItemContextMenu}
                now={now}
                runGlyph={runGlyphById?.get(row.item.id)}
              />
            ),
          )
        : items.map((item) => (
            <BacklogOptionRow
              key={item.id}
              item={item}
              optionIndex={navIndexById.get(item.id) ?? -1}
              selected={item.id === selectedId}
              onSelect={onSelect}
              onItemDragStart={onItemDragStart}
              onItemContextMenu={onItemContextMenu}
              now={now}
              runGlyph={runGlyphById?.get(item.id)}
            />
          ))}
    </ul>
  )
}

// One selectable backlog row (`role="option"`). Shared by the flat list and the
// grouped list's children so the stripe/selection treatment can't drift. The
// left-edge stripe resolves to the manual highlight color, or — when none is set
// — the derived risk×effort heat (nothing persisted). A hand-set highlight earns
// the full lit treatment (stripe + soft bg, mirroring the sidebar rowAccent
// override); a derived color tints the stripe alone so the ambient heat never
// competes with selection. `indented` nests the row under a group header; at the
// default (false) the class string is byte-identical to the pre-grouping row.
function BacklogOptionRow({
  item,
  optionIndex,
  selected,
  indented = false,
  onSelect,
  onItemDragStart,
  onItemContextMenu,
  now,
  runGlyph,
}: {
  item: BacklogItem
  optionIndex: number
  selected: boolean
  indented?: boolean
  onSelect: (id: string) => void
  onItemDragStart?: (event: React.DragEvent<HTMLLIElement>, item: BacklogItem) => void
  onItemContextMenu?: (event: React.MouseEvent, item: BacklogItem) => void
  now: number
  runGlyph?: BacklogRunGlyph
}): JSX.Element {
  const archived = item.status === 'archived'
  const manualColor = item.highlight?.color ?? null
  const stripeColor = resolveBacklogStripeColor(item)
  const swatch = stripeColor ? getHighlightSwatch(stripeColor) : null
  const litFill = manualColor !== null
  return (
    <li
      id={`backlog-opt-${optionIndex}`}
      role="option"
      aria-selected={selected}
      draggable={Boolean(onItemDragStart)}
      onDragStart={onItemDragStart ? (event) => onItemDragStart(event, item) : undefined}
      onContextMenu={onItemContextMenu ? (event) => onItemContextMenu(event, item) : undefined}
      onClick={() => onSelect(item.id)}
      title={item.relativePath}
      className={`cursor-pointer border-l-[3px] ${indented ? 'pl-6 pr-3' : 'px-3'} py-1.5 transition-colors ${
        selected
          ? `${swatch ? swatch.border : 'border-l-[color:var(--accent-primary)]'} ${litFill && swatch ? swatch.bg : 'bg-[color:var(--accent-primary-soft)]'} ${indented ? 'pl-[21px]' : 'pl-[9px]'}`
          : `${swatch ? `${swatch.border}${litFill ? ` ${swatch.dimBg}` : ''}` : 'border-l-transparent'} hover:bg-[color:var(--bg-hover)]`
      } ${archived ? 'opacity-70' : ''}`}
    >
      <BacklogRowContent item={item} now={now} runGlyph={runGlyph} />
    </li>
  )
}

// An epic/unknown/no-epic group header row. It is a navigable `role="option"` so
// j/k can reach it and Enter can collapse it. An epic header borrows the epic
// item's identity — clicking it (away from the chevron) selects the epic and can
// be dragged / right-clicked like any item; unknown and no-epic headers carry no
// item, so the whole row toggles collapse. The left stripe uses the epic's
// `color:` frontmatter when set.
function BacklogGroupHeaderRow({
  row,
  optionIndex,
  selected,
  onSelect,
  onToggleCollapse,
  onItemDragStart,
  onItemContextMenu,
}: {
  row: Extract<BacklogGroupedRow, { kind: 'header' }>
  optionIndex: number
  selected: boolean
  onSelect: (id: string) => void
  onToggleCollapse: (group: BacklogEpicGroup) => void
  onItemDragStart?: (event: React.DragEvent<HTMLLIElement>, item: BacklogItem) => void
  onItemContextMenu?: (event: React.MouseEvent, item: BacklogItem) => void
}): JSX.Element {
  const { group } = row
  const epic = group.kind === 'epic' ? group.epic : null
  const swatch = group.color ? getHighlightSwatch(group.color) : null
  return (
    <li
      id={`backlog-opt-${optionIndex}`}
      role="option"
      aria-selected={selected}
      draggable={Boolean(epic && onItemDragStart)}
      onDragStart={epic && onItemDragStart ? (event) => onItemDragStart(event, epic) : undefined}
      onContextMenu={epic && onItemContextMenu ? (event) => onItemContextMenu(event, epic) : undefined}
      // Clicking an epic header selects the epic (its detail); a header with no
      // item has nothing to select, so the row click collapses it instead.
      onClick={() => (epic ? onSelect(epic.id) : onToggleCollapse(group))}
      title={epic ? epic.relativePath : group.title}
      className={`cursor-pointer border-l-[3px] px-3 py-1.5 transition-colors ${
        selected
          ? `${swatch ? swatch.border : 'border-l-[color:var(--accent-primary)]'} bg-[color:var(--accent-primary-soft)] pl-[9px]`
          : `${swatch ? swatch.border : 'border-l-transparent'} hover:bg-[color:var(--bg-hover)]`
      }`}
    >
      <BacklogEpicHeaderContent
        group={group}
        collapsed={row.collapsed}
        onToggleCollapse={() => onToggleCollapse(group)}
      />
    </li>
  )
}

// ---- Detail / preview ------------------------------------------------------

function BacklogDetail({
  scan,
  loading,
  folderPath,
  selected,
  selectedRunGlyph,
  now,
  hasItems,
  externalActions,
  workspaceId,
  linkProviders,
  showBack,
  onBack,
  actions,
  epicChoices,
}: {
  scan: BacklogScanResult | null
  loading: boolean
  folderPath: string | null
  selected: BacklogItem | null
  selectedRunGlyph?: BacklogRunGlyph
  now: number
  hasItems: boolean
  externalActions: Array<{ action: BacklogItemAction; disabled: boolean; run: () => void }>
  workspaceId: string
  linkProviders: ReadonlyArray<BacklogLinkProvider>
  showBack: boolean
  onBack: () => void
  actions: BacklogActions
  epicChoices: ReadonlyArray<BacklogEpicChoice>
}): JSX.Element {
  if (!folderPath) {
    return (
      <DetailState
        heading="No workspace folder"
        body="Backlog reads captured items from a project's backlog/ folder. Open a project folder to use it."
      />
    )
  }
  if (loading && !scan) {
    return <BacklogDetailSkeleton />
  }
  if (scan?.state === 'missing-folder') {
    return (
      <DetailState
        heading="No backlog folder"
        body="This workspace has no backlog/ folder yet. Create one to start capturing items."
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
        body="Nothing under backlog/ yet. Capture a rough idea, note, or feature, or drop a Markdown or HTML file in to get started."
        cta={<PrimaryButton onClick={actions.createPlan}>Capture first item</PrimaryButton>}
      />
    )
  }
  if (!selected) {
    return <DetailState body="Select an item to preview." />
  }

  // The first sprintengine.run execution link is the primary Open Sprint Engine
  // target (its action lives in the header), so it is kept out of the secondary
  // Links list — one existing run reads as one Open action, not a link
  // collection. Only de-dup when that primary action is actually present: it and
  // the provider share module enablement, and the action hides for archived
  // items, so absent an enabled provider or on an archived item the run link
  // stays visible as safe unavailable metadata instead of disappearing.
  const primaryRunLink = sprintEngineRunLinkForItem(selected)
  const primaryRunLinkId =
    primaryRunLink
    && selected.status !== 'archived'
    && providerForBacklogLink(linkProviders, primaryRunLink)
      ? primaryRunLink.id
      : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-[color:var(--border-default)] px-4 py-3">
        {/* Back row: the timestamp sits top-right at the same level, so the
            title below gets its full width instead of stacking meta lines. */}
        <div className="flex h-6 items-center justify-between gap-2">
          {showBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to list"
              className="interactive -ml-1.5 inline-flex h-6 items-center gap-1 rounded px-1.5 text-[12px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
            >
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Back
            </button>
          ) : (
            <span />
          )}
          <span className="shrink-0 tabular-nums text-[11px] text-[color:var(--text-subtle)]">
            {formatRelativeMsAgo(selected.modifiedAt, now) || 'unknown'}
          </span>
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-2">
          <Tooltip content={selectedRunGlyph?.label ?? BACKLOG_STATUS_LABEL[selected.status]} placement="top">
            <LifecycleGlyph
              state={selectedRunGlyph?.state ?? backlogStatusToLifecycle(selected.status)}
              live={selectedRunGlyph?.live ?? true}
            />
          </Tooltip>
          <TruncatedText as="h3" text={selected.title} className="text-[14px] font-semibold text-[color:var(--text-strong)]" />
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-[color:var(--text-muted)]">
          {(selectedRunGlyph?.label ?? LIFECYCLE_LABEL[selected.status]) ? (
            <>
              <span>{selectedRunGlyph?.label ?? LIFECYCLE_LABEL[selected.status]}</span>
              <span aria-hidden="true" className="text-[color:var(--text-disabled)]">·</span>
            </>
          ) : null}
          <TruncatedText as="span" text={selected.relativePath} className="min-w-0 font-mono tabular-nums" />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
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
            ariaLabel="Item actions"
            items={[
              ...(selected.status !== 'archived' && selected.status !== 'completed'
                ? [{ id: 'mark-completed', label: 'Mark completed', onSelect: () => actions.setStatus(selected, 'completed') }]
                : []),
              {
                id: 'star',
                label: selected.highlight?.starred ? 'Unstar' : 'Star',
                onSelect: () =>
                  actions.setHighlight(selected, {
                    starred: !selected.highlight?.starred,
                    color: selected.highlight?.color ?? null,
                  }),
              },
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

      <BacklogLinksSection
        item={selected}
        workspaceId={workspaceId}
        workspaceRoot={folderPath}
        providers={linkProviders}
        excludeLinkId={primaryRunLinkId}
      />

      <BacklogTriage item={selected} actions={actions} epicChoices={epicChoices} />

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <BacklogPreviewBody item={selected} />
      </div>
    </div>
  )
}

// Detail placeholder shown on first load before any item is scanned/selected:
// a title bar plus a few body lines on the detail ground, so the preview reveals
// into a familiar shape rather than flashing a "Loading…" line. Decorative; the
// list's skeleton already carries the screen-reader status for the load.
function BacklogDetailSkeleton(): JSX.Element {
  return (
    <div aria-hidden="true" className="flex h-full flex-col gap-4 p-4">
      <Skeleton className="h-5 w-[56%] rounded bg-[color:var(--skeleton-shimmer-high)]" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-full rounded bg-[color:var(--skeleton-shimmer-high)]" />
        <Skeleton className="h-3 w-[92%] rounded bg-[color:var(--skeleton-shimmer-high)]" />
        <Skeleton className="h-3 w-[68%] rounded bg-[color:var(--skeleton-shimmer-high)]" />
      </div>
      <div className="mt-2 flex flex-col gap-2">
        <Skeleton className="h-3 w-[84%] rounded bg-[color:var(--skeleton-shimmer-high)]" />
        <Skeleton className="h-3 w-[47%] rounded bg-[color:var(--skeleton-shimmer-high)]" />
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

// Sentinel + cleared values for the detail-pane Epic Select. '' clears the
// `epic:` field (No epic); the sentinel opens the create-epic prompt.
const EPIC_NEW_SENTINEL = '__new_epic__'
const EPIC_NONE_VALUE = ''

// Triage editor: size + priority + risk + epic are owned organization metadata.
// Selecting "Unestimated" / "No priority" / "No risk set" / "No epic" clears the
// axis back to neutral. Risk is the likelihood the work goes sideways — distinct
// from effort and impact — and feeds the Best sort and the row's derived heat
// color. The Epic control is the detail-pane peer of the row menu's "Move to
// epic"; it is hidden for epic items, which cannot nest inside another epic.
function BacklogTriage({
  item,
  actions,
  epicChoices,
}: {
  item: BacklogItem
  actions: BacklogActions
  epicChoices: ReadonlyArray<BacklogEpicChoice>
}): JSX.Element {
  const epicItems: SelectItem<string>[] = [
    { value: EPIC_NONE_VALUE, label: 'No epic' },
    ...epicChoices.map((epic) => ({ value: epic.slug, label: epic.title })),
    // A dangling slug (its concept file is missing) stays a visible option so the
    // control reflects the item's real frontmatter instead of silently blanking.
    ...(item.epic && !epicChoices.some((epic) => epic.slug === item.epic)
      ? [{ value: item.epic, label: `${item.epic} (missing)` }]
      : []),
    { value: EPIC_NEW_SENTINEL, label: 'New epic…' },
  ]
  return (
    <Section title="Triage" level={4} inset className="shrink-0 border-b border-[color:var(--border-subtle)] pb-3">
      <div className="grid grid-cols-[3.5rem_minmax(0,16rem)] items-center gap-x-3 gap-y-2 px-3">
        <span className="text-[11px] text-[color:var(--text-muted)]">Size</span>
        <Select
          ariaLabel="Set size"
          items={DIFFICULTY_EDIT_ITEMS}
          value={item.difficulty ?? 'unset'}
          onChange={(value) => actions.setDifficulty(item, value)}
        />
        <span className="text-[11px] text-[color:var(--text-muted)]">Priority</span>
        <Select
          ariaLabel="Set priority"
          items={CRITICALITY_EDIT_ITEMS}
          value={item.criticality ?? 'unset'}
          onChange={(value) => actions.setCriticality(item, value)}
        />
        <span className="text-[11px] text-[color:var(--text-muted)]">Risk</span>
        <Select
          ariaLabel="Set risk"
          items={RISK_EDIT_ITEMS}
          value={item.risk ?? 'unset'}
          onChange={(value) => actions.setRisk(item, value)}
        />
        {!item.isEpic ? (
          <>
            <span className="text-[11px] text-[color:var(--text-muted)]">Epic</span>
            <Select
              ariaLabel="Move to epic"
              items={epicItems}
              value={item.epic ?? EPIC_NONE_VALUE}
              onChange={(value) => {
                if (value === EPIC_NEW_SENTINEL) actions.createEpic(item)
                else actions.setEpic(item, value === EPIC_NONE_VALUE ? null : value)
              }}
            />
          </>
        ) : null}
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

function assertBacklogMutation(result: { ok: boolean; message?: string }): void {
  if (!result.ok) throw new Error(result.message || 'Unable to update Backlog metadata.')
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

function listEmptyHint(
  scan: BacklogScanResult | null,
  totalItems: number,
  filteredCount: number,
  loading: boolean,
): string | null {
  // First load renders the row skeleton (BacklogList), not a text hint.
  if (loading && !scan) return null
  if (!scan) return null
  if (scan.state === 'missing-folder') return 'No backlog/ folder in this workspace yet.'
  if (scan.state === 'error') {
    const error = scan.errors[0]
    return error
      ? `Couldn’t read the backlog folder: ${error.relativePath}: ${error.message}`
      : 'Couldn’t read the backlog folder.'
  }
  if (totalItems === 0) return 'Backlog is empty.'
  if (filteredCount === 0) return 'No items match the current view and search.'
  return null
}

// The backlog row interior and its type / size / criticality glyphs live in the
// shared ../backlog/BacklogRow module so this panel list and the new-workspace
// Sprint Engine source picker render the same row and can't drift.

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
