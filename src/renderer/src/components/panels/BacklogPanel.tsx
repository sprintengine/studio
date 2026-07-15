import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  GhostButton,
  IconButton,
  InboxSearchInput,
  InlineNotice,
  LifecycleGlyph,
  MenuItem,
  OverflowMenu,
  PanelHeader,
  Popover,
  PrimaryButton,
  Section,
  Skeleton,
  Tooltip,
  TruncatedText,
  useConfirmDialog,
  type SelectItem,
} from '../ui'
import { useShallow } from 'zustand/react/shallow'
import type { AgentState } from '../../types/workspace'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { selectBacklogProjectView, useBacklogViewStore } from '../../store/backlogViewStore'
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
import { findDuplicateBacklogIds } from '../../../../shared/backlog/item-id'
import {
  backlogItemSlugFromPath,
  backlogPreviewMarkdown,
  backlogRootPath,
  nextArchiveRelativePath,
  normalizeRelativePath,
  stableBacklogObjectId,
  type BacklogCriticality,
  type BacklogDifficulty,
  type BacklogHighlight,
  type BacklogHighlightColor,
  type BacklogItem,
  type BacklogItemLink,
  type BacklogItemStatus,
  type BacklogRisk,
  type BacklogScanResult,
} from '../../utils/backlog'
import { getHighlightSwatch } from '../../utils/highlight'
import { nextBacklogItemStatusFromLinks, providerForBacklogLink } from '../../utils/backlogLinks'
import {
  matchWorkspaceForBacklogRunLink,
  sprintEngineRunLinkForItem,
} from '../../utils/sprintengineBacklogLinks'
import { deriveSprintEngineRunGlyph } from '../../utils/sprintengine'
import { BacklogLinksSection } from '../backlog/BacklogLinksSection'
import { BacklogDependenciesSection } from '../backlog/BacklogDependenciesSection'
import { BacklogItemSearchPicker } from '../backlog/BacklogItemSearchPicker'
import { BacklogFilterMenu } from '../backlog/BacklogFilterMenu'
import {
  compareBacklogItems,
  matchesBacklogView,
  resolveBacklogRowColor,
  type BacklogGroup,
  type BacklogSort,
  type BacklogView,
} from '../../utils/backlogTriage'
import {
  childrenOfEpic,
  epicGroupKey,
  epicMetaBySlug,
  epicProgressBySlug,
  epicSlug,
  groupItemsByEpic,
  groupedBacklogRows,
  isBacklogHeaderNavId,
  planEpicArchive,
  type BacklogEpicGroup,
  type BacklogEpicMeta,
  type BacklogEpicProgress,
  type BacklogGroupedRow,
} from '../../utils/backlogEpics'
import { deriveBacklogDependencies, type BacklogDependencyNode } from '../../utils/backlogDependencies'
import {
  AgentTargetMenuItems,
  BacklogItemContextMenu,
  CRITICALITY_EDIT_ITEMS,
  DIFFICULTY_EDIT_ITEMS,
  MenuCheckGlyph,
  RISK_EDIT_ITEMS,
  STATUS_MENU_CHOICES,
  type BacklogActions,
  type BacklogDependencyChoice,
  type BacklogEpicChoice,
} from '../backlog/BacklogItemContextMenu'
import { BacklogCreateDialog, type BacklogDraft } from './BacklogCreateDialog'
import {
  BacklogEpicHeaderContent,
  BacklogRowContent,
  BacklogRowHoverCard,
  BACKLOG_STATUS_LABEL,
  backlogStatusToLifecycle,
  CriticalityIndicator,
  DifficultyIndicator,
  EpicColorDot,
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
// ranges a single-value dropdown can't (XS/S, L/XL), and the terminal Completed
// and Archived states are reached here rather than via a separate status
// control. Active is the default — the live working set with the two terminal
// states hidden — while All items is the firehose that hides nothing.
const VIEW_ITEMS: SelectItem<BacklogView>[] = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All items' },
  { value: 'epics', label: 'Epics' },
  { value: 'quick_wins', label: 'Quick wins' },
  { value: 'strategic_bets', label: 'Strategic bets' },
  { value: 'defer', label: 'Defer candidates' },
  { value: 'unestimated', label: 'Unestimated' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
]

const SORT_ITEMS: SelectItem<BacklogSort>[] = [
  { value: 'best', label: 'Best' },
  { value: 'recent', label: 'Recently updated' },
  { value: 'created', label: 'Recently created' },
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'largest', label: 'Largest first' },
  { value: 'smallest', label: 'Smallest first' },
  { value: 'dependency', label: 'Dependency order' },
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
  epics: 'epics',
  quick_wins: 'quick wins',
  strategic_bets: 'strategic bets',
  defer: 'defer candidates',
  unestimated: 'unestimated',
  completed: 'completed',
  archived: 'archived',
}

// The lens that surfaces a given item when revealing or navigating to it: its
// own terminal view for finished/archived items (which the default Active lens
// hides), else the Active working set.
function lensForItemStatus(status: BacklogItemStatus): BacklogView {
  if (status === 'archived') return 'archived'
  if (status === 'completed') return 'completed'
  return 'active'
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
  // Search is ephemeral: a transient act, never persisted or shared, so each
  // window's box starts empty and typing here never leaks to another workspace.
  const [search, setSearch] = useState('')
  // The lens/sort/grouping are PROJECT-scoped (shared + live-synced across every
  // workspace on this project) via the backlog view store, so the backlog reads
  // as one list per project instead of diverging per window. Reading through a
  // useShallow selector keeps re-renders to actual value changes.
  const { view, sort, group } = useBacklogViewStore(
    useShallow((state) => selectBacklogProjectView(state, folderPath)),
  )
  const setProjectView = useBacklogViewStore((state) => state.setProjectView)
  const handleViewChange = useCallback(
    (next: BacklogView) => setProjectView(folderPath, { view: next }),
    [setProjectView, folderPath],
  )
  const handleSortChange = useCallback(
    (next: BacklogSort) => setProjectView(folderPath, { sort: next }),
    [setProjectView, folderPath],
  )
  const handleGroupChange = useCallback(
    (next: BacklogGroup) => setProjectView(folderPath, { group: next }),
    [setProjectView, folderPath],
  )
  // One-time migration: the first panel to mount on a project seeds the shared
  // lens/sort/group from its own legacy per-workspace record, so preferences set
  // before this change carry over; later mounts read the shared value.
  useEffect(() => {
    useBacklogViewStore.getState().seedProjectViewIfAbsent(folderPath, initialBacklogState)
  }, [folderPath, initialBacklogState])
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
  // on that folder. The lens/sort/grouping are likewise project-scoped (shared +
  // live-synced via the backlog view store); only the selected item is persisted
  // per workspace (see the restore + persist effects below), and search is
  // ephemeral, so a reload/restart returns to the same item under the shared lens.
  const { scan, loading, refresh: runScan } = useSharedBacklogScan(folderPath)

  // The shared store returns scan=null for a missing folder; mirror the old
  // behavior of clearing the local selection/detail view in that case.
  useEffect(() => {
    if (folderPath) return
    setSelectedId(null)
    setShowDetailInSingle(false)
  }, [folderPath])

  const items = scan?.items ?? []

  // The dependency graph (T2) is derived once over the FULL item set — never the
  // filtered view — so prerequisite resolution and the waiting signal stay
  // accurate regardless of the active lens (a prerequisite hidden by a filter
  // still resolves to its real status). Recomputed only when the scan changes,
  // like runGlyphById. Feeds the waiting badges, the detail Prerequisites/Blocks
  // section, and the "Dependency order" sort.
  const dependencyGraph = useMemo(() => deriveBacklogDependencies(items), [items])
  const waitingById = useMemo(() => {
    const map = new Map<string, true>()
    for (const node of dependencyGraph.nodes) if (node.isWaiting) map.set(node.item.id, true)
    return map
  }, [dependencyGraph])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    const matched = items.filter((item) => {
      // The view lens owns archived visibility (its own option) and the
      // difficulty/criticality triage ranges; search narrows within it.
      if (!matchesBacklogView(item, view)) return false
      if (query && !matchesQuery(item, query)) return false
      return true
    })
    // "Dependency order" is a whole-list topological transform, not a pairwise
    // key, so it branches around compareBacklogItems: take the full-graph topo
    // order (prerequisites before dependents, unblocked frontier first) and keep
    // only the visible rows, preserving that order. Every other sort keeps the
    // stable pairwise comparator (path order as the deterministic tiebreak).
    if (sort === 'dependency') {
      const visible = new Set(matched.map((item) => item.id))
      return dependencyGraph.order.filter((item) => visible.has(item.id))
    }
    return matched.sort((a, b) => compareBacklogItems(a, b, sort))
  }, [items, search, view, sort, dependencyGraph])

  // Epic grouping is an orthogonal axis layered over the filtered+sorted list.
  // `none` keeps the flat list untouched (groupedRows stays null → the panel
  // renders today's path); `by_epic` partitions into ordered epic/unknown/no-epic
  // groups and flattens them (headers + visible children) into the render +
  // keyboard order. Children keep the active sort because `filtered` is already
  // sorted and groupItemsByEpic preserves input order.
  // A group's collapse state = its default flipped by any explicit user toggle.
  // Default: expanded — except an epic group in a terminal lens (Completed or
  // Archived), which defaults collapsed so a finished epic reads as one
  // rolled-up unit, not N loose child rows (T11). `collapsedGroups` records the
  // groups the user flipped away from their default, so the chevron toggle works
  // the same in every lens.
  const isGroupCollapsed = useCallback(
    (epicGroup: BacklogEpicGroup) => {
      const defaultCollapsed =
        (view === 'archived' || view === 'completed') && epicGroup.kind === 'epic'
      const flipped = collapsedGroups.has(epicGroupKey(epicGroup))
      return flipped ? !defaultCollapsed : defaultCollapsed
    },
    [collapsedGroups, view],
  )
  const groupedRows = useMemo<BacklogGroupedRow[] | null>(() => {
    if (group !== 'by_epic') return null
    // The Epics lens filters to the containers themselves, so by-epic grouping
    // would render every epic as a childless header — an arrow that expands to
    // nothing. Render them as flat epic rows (status + completion) instead.
    if (view === 'epics') return null
    return groupedBacklogRows(groupItemsByEpic(filtered), isGroupCollapsed)
  }, [group, view, filtered, isGroupCollapsed])

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
        .map((group) => ({
          slug: group.slug as string,
          title: group.title,
          displayId: group.epic?.displayId,
        })),
    [items],
  )

  // slug -> { title, color } for every epic, so a member row can resolve its
  // epic's identity colour (the option-C tint) and name (the flat-view chip),
  // and the detail pane can render the colour picker, children roll-up, and the
  // child's parent-epic crumb — all from one derived map (never persisted).
  const epicMeta = useMemo(() => epicMetaBySlug(items), [items])
  // slug -> true completion (completed/total children over the FULL scan), so
  // epic rows and group headers report real progress no matter which lens is
  // hiding the children. Like epicMeta, derived once per scan and never stored.
  const epicProgress = useMemo(() => epicProgressBySlug(items), [items])
  // Candidate prerequisites for the "Depends on…" affordances: every non-epic
  // item by id + slug (filename stem, the `dependsOn` target) + title. Drawn from
  // the full scan so a prerequisite can be set regardless of the active lens; the
  // menu and detail editor drop the current item by id. Epics are grouping
  // containers, never prerequisites, so they are excluded.
  const dependencyChoices = useMemo<BacklogDependencyChoice[]>(
    () =>
      items
        .filter((item) => !item.isEpic)
        .map((item) => ({
          id: item.id,
          slug: backlogItemSlugFromPath(item.relativePath),
          title: item.title,
          displayId: item.displayId,
        })),
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

  // Live run glyph per item linked to an observable Sprint Engine run. Built over
  // the full scan (not `filtered`) so an epic's detail can roll its members' real
  // merge state into the epic's own glyph even when a lens hides some children.
  // The rollup (`deriveSprintEngineRunGlyph`) is shared with the workspace
  // sidebar: a human-routed needs_input wins over everything, then the AutoRun
  // runtime. A null rollup (idle/manual runner, or workspace not observable here)
  // keeps the item's own status rendering — an in-progress item spins by default.
  // Derived with useMemo (not inside the Zustand selector) so it never returns a
  // fresh map from the store snapshot.
  const runGlyphById = useMemo(() => {
    const map = new Map<string, BacklogRunGlyph>()
    if (!folderPath) return map
    for (const item of items) {
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
  }, [items, sprintEngineWorkspaces, folderPath])

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

  // The selected item's effective run glyph. A leaf item carries its own Sprint
  // Engine run link, so it reads directly. An epic has no run link of its own —
  // without this it would fall back to its coarse `completed` status and show the
  // green tick even once every member's PR has merged. Roll the members' real run
  // states up into the epic's glyph so a merged epic reads "Merged" (purple
  // branch), matching what each member shows in the list.
  const selectedRunGlyph = useMemo(() => {
    if (!selected) return undefined
    if (selected.isEpic) return deriveEpicRunGlyphFromChildren(selected, items, runGlyphById)
    return runGlyphById.get(selected.id)
  }, [selected, items, runGlyphById])

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
      // `selected` derives from `filtered`, so reset search and widen the lens to
      // one that contains the item (its terminal view if completed/archived, else
      // the Active working set) to keep the row visible beside its detail.
      setPendingReveal(null)
      setSearch('')
      setProjectView(folderPath, { view: lensForItemStatus(item.status) })
      setSelectedId(item.id)
      setShowDetailInSingle(true)
    } else if (items.length > 0) {
      // Scan is loaded and the item isn't here (e.g. just deleted): give up
      // quietly — the panel is at least open. An empty scan keeps waiting.
      setPendingReveal(null)
    }
  }, [pendingReveal, items, setProjectView, folderPath])

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

  // Persist the selected item per workspace so a reload/restart restores which
  // item's detail was open (a per-window navigation position). The lens/sort/
  // grouping are NOT persisted here — they live in the project-scoped backlog
  // view store — and search is ephemeral. Gated on restorePending so we never
  // overwrite the persisted selection before it has been restored; the unmount
  // effect flushes on close, the debounce covers a Cmd-R reload / layer switch.
  const backlogPersistRef = useRef({
    selectedRelativePath: null as string | null,
    restorePending,
  })
  backlogPersistRef.current = {
    selectedRelativePath: selected?.relativePath ?? null,
    restorePending,
  }
  const persistBacklogViewState = useCallback(() => {
    const snapshot = backlogPersistRef.current
    if (snapshot.restorePending != null) return
    // Don't create a record just by opening the panel for an untouched workspace;
    // only persist once there is a selection to remember (or a record exists).
    const hasRecord = Boolean(
      useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.backlogState,
    )
    if (!snapshot.selectedRelativePath && !hasRecord) return
    setBacklogViewState(workspaceId, {
      selectedRelativePath: snapshot.selectedRelativePath,
    })
  }, [workspaceId, setBacklogViewState])
  useEffect(() => {
    if (restorePending != null) return
    const handle = window.setTimeout(persistBacklogViewState, 300)
    return () => window.clearTimeout(handle)
  }, [restorePending, selectedId, persistBacklogViewState])
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

  // Cross-navigation from the detail pane (a prerequisite or a blocked item).
  // Unlike a list-row click, the target may sit outside the active lens/search —
  // a resolved prerequisite under an active-only lens, an archived target (every
  // non-archived lens hides archived), or anything the search query excludes. The
  // `selected` detail resolves only within `filtered` and the stale-selection
  // effect drops a selectedId that isn't visible, so selecting blindly would dead
  // click (blank the pane). Mirror the agent-glyph reveal: when the target isn't
  // already visible, widen to a lens that contains it (Completed/Archived for a
  // terminal item, else the Active working set) and clear the search so the row —
  // and its detail — stay in view.
  const navigateToBacklogItem = useCallback(
    (id: string) => {
      const target = items.find((item) => item.id === id)
      if (!target) return
      if (!filtered.some((item) => item.id === id)) {
        setSearch('')
        setProjectView(folderPath, { view: lensForItemStatus(target.status) })
      }
      setSelectedId(id)
      setShowDetailInSingle(true)
    },
    [items, filtered, setProjectView, folderPath],
  )

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

  // Snapshot of the relative paths already under backlog/archived/, the dedup
  // baseline for nextArchiveRelativePath (so a new archive never reuses a name).
  const archivedRelativePaths = useCallback(
    () => (scan?.items ?? []).filter((i) => i.status === 'archived').map((i) => i.relativePath),
    [scan],
  )

  // Archive one item to a pre-resolved collision-safe `backlog/archived/<name>`
  // path: move the live on-disk file (read → write into the new target → trash
  // the source), re-point open editor tabs, then update the items.json record.
  // Throws on any step so the caller can surface the failure; on a partial write
  // it cleans up the archived copy so archive never leaves a duplicate. Shared by
  // the single-item Archive and the epic rollup so they cannot drift.
  const moveItemToArchive = useCallback(
    async (item: BacklogItem, archivedRel: string): Promise<void> => {
      if (!folderPath) return
      const archivedName = archivedRel.slice(archivedRel.lastIndexOf('/') + 1)
      const content = await window.api.readfile(item.path)
      const archivedDir = await window.api.ensureDir(backlogRootPath(folderPath), 'archived')
      const newPath = await window.api.createFile(archivedDir, archivedName)
      try {
        await window.api.writefile(newPath, content)
        await window.api.deletePath(item.path)
      } catch (error) {
        await window.api.deletePath(newPath).catch(() => {})
        throw error
      }
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
    },
    [folderPath, remapOpenFiles, workspaceId],
  )

  const archiveItem = useCallback(
    (item: BacklogItem) =>
      runAction(async () => {
        if (!folderPath || item.status === 'archived') return
        const archivedRel = nextArchiveRelativePath(item.relativePath, archivedRelativePaths())
        await moveItemToArchive(item, archivedRel)
        await refreshAndSelect(normalizeRelativePath(archivedRel))
      }),
    [archivedRelativePaths, folderPath, moveItemToArchive, refreshAndSelect, runAction],
  )

  // Archive-epic rollup: archive every active child, then the epic itself, via
  // the same archive-move path. `planEpicArchive` resolves the collision-safe
  // targets up front and, when a `backlog/archived/<stem>.md` collision renames
  // the epic, marks each child to be re-pointed to the epic's new stem first —
  // otherwise the children (keyed on the old stem via their `epic:` frontmatter)
  // would scatter into "Unknown epic" and the archived epic would be empty,
  // breaking AC2's single-unit rollup. Children go first so a mid-batch failure
  // leaves the epic recoverable rather than an archived epic with live children.
  const archiveEpicRollup = useCallback(
    (epic: BacklogItem) =>
      runAction(async () => {
        if (!folderPath || epic.status === 'archived' || !epic.isEpic) return
        const children = childrenOfEpic(items, epicSlug(epic)).filter((child) => child.status !== 'archived')
        const plan = planEpicArchive(epic, children, archivedRelativePaths())
        try {
          for (const move of plan.children) {
            // Re-point the child to the epic's final (possibly renamed) slug
            // before the move, so the archived copy carries the matching `epic:`.
            if (move.repointEpic !== null) {
              const repointed = await window.api.updateBacklogEpic({
                workspaceRoot: folderPath,
                relativePath: move.item.relativePath,
                epic: move.repointEpic,
              })
              assertBacklogMutation(repointed)
            }
            await moveItemToArchive(move.item, move.archivedRel)
          }
          await moveItemToArchive(epic, plan.epicArchivedRel)
        } catch (error) {
          // Some members may have archived before the failure; re-scan so the UI
          // reflects the real on-disk state, then surface the error.
          await runScan()
          throw error
        }
        await refreshAndSelect(normalizeRelativePath(plan.epicArchivedRel))
      }),
    [archivedRelativePaths, folderPath, items, moveItemToArchive, refreshAndSelect, runAction, runScan],
  )

  const deleteItem = useCallback(
    (item: BacklogItem) =>
      runAction(async () => {
        const confirmed = await dialog.confirm({
          title: 'Delete item?',
          body: `“${item.title}” will be moved to the trash. This affects the file only — no sprint state changes.`,
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

  // Triage edits (difficulty/criticality/risk) route through updateBacklogTriage
  // to the item's markdown frontmatter under schema-v2 — frontmatter is the
  // source of truth for these axes, not items.json — then re-scan, so they are
  // real persisted metadata and never disconnected UI state.
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
        const executionLinks = item.links.filter((link) => link.type === 'execution')
        // An epic's status is derived UP from its children, not from its own run
        // link (see nextBacklogItemStatusFromLinks); a leaf's is derived from its
        // execution links. Severing the link only makes a manual status stick when
        // the status is LINK-driven, so it is offered only for a leaf (or a
        // childless epic behaving like one) — never for a child-driven epic.
        const epicChildStatuses = item.isEpic
          ? childrenOfEpic(items, epicSlug(item)).map((child) => child.status)
          : undefined
        const childDriven = (epicChildStatuses?.length ?? 0) > 0
        const derivedStatus = nextBacklogItemStatusFromLinks(item.status, item.links, epicChildStatuses)
        // Setting the status the derivation would produce anyway is a no-op, not an
        // override: keep the link and just write the status. The sever warning is
        // reserved for a genuinely contradictory manual set on a link-driven item —
        // otherwise the next sync tick would revert the manual status back.
        const needsUnlink = executionLinks.length > 0 && !childDriven && status !== derivedStatus
        if (needsUnlink) {
          const confirmed = await dialog.confirm({
            title: 'Override linked status?',
            body: `Setting “${BACKLOG_STATUS_LABEL[status]}” will unlink ${executionLinks.length === 1 ? 'the linked sprint' : `${executionLinks.length} linked executions`}. The run itself will not be deleted.`,
            confirmLabel: `Unlink and set ${BACKLOG_STATUS_LABEL[status]}`,
          })
          if (!confirmed) return
          for (const link of executionLinks) {
            const unlinked = await window.api.removeBacklogLink({
              workspaceRoot: folderPath,
              relativePath: item.relativePath,
              linkId: link.id,
            })
            assertBacklogMutation(unlinked)
          }
        }
        const updated = await window.api.updateBacklogStatus({
          workspaceRoot: folderPath,
          relativePath: item.relativePath,
          status,
        })
        assertBacklogMutation(updated)
        await runScan()
      }),
    [dialog, folderPath, items, runAction, runScan],
  )

  const removeItemLink = useCallback(
    (item: BacklogItem, link: BacklogItemLink) =>
      runAction(async () => {
        if (!folderPath) return
        const confirmed = await dialog.confirm({
          title: `Unlink ${link.label}?`,
          body: 'This removes only the Backlog association. The linked sprint, agent, or external target will not be deleted.',
          confirmLabel: 'Unlink',
        })
        if (!confirmed) return
        const removed = await window.api.removeBacklogLink({
          workspaceRoot: folderPath,
          relativePath: item.relativePath,
          linkId: link.id,
        })
        assertBacklogMutation(removed)
        await runScan()
      }),
    [dialog, folderPath, runAction, runScan],
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

  // Prerequisites are the dependent's `dependsOn:` frontmatter only
  // (backlog:update-dependencies rewrites the markdown via the shared serializer;
  // items.json is untouched). The full slug list is rewritten each time; null /
  // empty clears the line. The service de-dupes/validates and drops self, so the
  // UI just sends the toggled set and re-scans.
  const setItemDependencies = useCallback(
    (item: BacklogItem, slugs: string[] | null) =>
      runAction(async () => {
        if (!folderPath) return
        const updated = await window.api.updateBacklogDependencies({
          workspaceRoot: folderPath,
          relativePath: item.relativePath,
          dependsOn: slugs,
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

  // Set (or clear) an epic's identity colour. Writes the epic file's `color:`
  // frontmatter via backlog:update-epic-color — distinct from the per-item
  // `highlight` (items.json), so the epic's members can derive a shared hue at
  // scan time. A no-op write is skipped so re-picking the current colour is free.
  const setEpicColorForItem = useCallback(
    (item: BacklogItem, color: BacklogHighlightColor | null) =>
      runAction(async () => {
        if (!folderPath) return
        const current = epicMeta.get(epicSlug(item))?.color ?? null
        if (current === color) return
        const updated = await window.api.updateBacklogEpicColor({
          workspaceRoot: folderPath,
          relativePath: item.relativePath,
          color,
        })
        assertBacklogMutation(updated)
        await runScan()
      }),
    [epicMeta, folderPath, runAction, runScan],
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
    archiveEpic: (item) => void archiveEpicRollup(item),
    remove: (item) => void deleteItem(item),
    removeLink: (item, link) => void removeItemLink(item, link),
    setStatus: (item, status) => void setItemStatus(item, status),
    setDifficulty: (item, value) => setItemTriage(item, { difficulty: value === 'unset' ? null : value }),
    setCriticality: (item, value) => setItemTriage(item, { criticality: value === 'unset' ? null : value }),
    setRisk: (item, value) => setItemTriage(item, { risk: value === 'unset' ? null : value }),
    setEpic: (item, slug) => void setItemEpic(item, slug),
    setDependencies: (item, slugs) => void setItemDependencies(item, slugs),
    createEpic: (item) => void createEpicForItem(item),
    setEpicColor: (item, color) => void setEpicColorForItem(item, color),
    setHighlight: (item, highlight) => void setItemHighlight(item, highlight),
  }

  // Partial scan: some files read but others failed. Surface the failures so a
  // dropped file never silently misleads (design §5 / north-star real-labels).
  const partialErrors = scan && scan.errors.length > 0 && items.length > 0 ? scan.errors : null

  // Duplicate display ids: the visible symptom of concurrent scan-max allocation
  // across unmerged branches. We surface it (naming the colliding files) rather
  // than silently renumbering — git merge plus this warning is the cure.
  const duplicateIdWarnings = useMemo(() => {
    const duplicates = findDuplicateBacklogIds(
      items.map((item) => ({ relativePath: item.relativePath, numericId: item.numericId ?? null })),
    )
    if (duplicates.length === 0) return null
    const displayById = new Map<number, string>()
    for (const item of items) {
      if (typeof item.numericId === 'number' && item.displayId) displayById.set(item.numericId, item.displayId)
    }
    return duplicates.map((duplicate) => ({
      label: displayById.get(duplicate.numericId) ?? `#${duplicate.numericId}`,
      paths: duplicate.relativePaths,
    }))
  }, [items])

  // The header count is the visible row count. The two whole-set views — Active
  // (the default working set) and All items (the firehose) — read as "the
  // backlog" and carry no scope word; every narrowing lens (Completed, Archived,
  // the triage presets) labels its scope so a bare number never reads as the
  // whole backlog (T16 AC3).
  const headerScopeLabel = view !== 'all' && view !== 'active'
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

  const externalActionsForItem = useCallback((item: BacklogItem) => {
    const context = backlogActionContext(item)
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
  }, [backlogActionContext, moduleOverrides, runAction])

  const externalActions = useMemo(
    () => selected ? externalActionsForItem(selected) : [],
    [externalActionsForItem, selected],
  )

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
  const menuItemActions = useMemo(
    () => menuItem
      ? externalActionsForItem(menuItem).map(({ action, disabled, run }) => ({
          id: action.id,
          label: action.label,
          disabled,
          run,
        }))
      : [],
    [externalActionsForItem, menuItem],
  )

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
      epicMetaBySlug={epicMeta}
      epicProgressBySlug={epicProgress}
      waitingById={waitingById}
    />
  )

  const detailPane = (
    <BacklogDetail
      scan={scan}
      loading={loading}
      folderPath={folderPath}
      selected={selected}
      selectedRunGlyph={selectedRunGlyph}
      runGlyphById={runGlyphById}
      now={now}
      hasItems={items.length > 0}
      externalActions={externalActions}
      workspaceId={workspaceId}
      linkProviders={linkProviders}
      showBack={!isSplit}
      onBack={() => setShowDetailInSingle(false)}
      actions={actions}
      epicChoices={epicChoices}
      items={items}
      epicMetaBySlug={epicMeta}
      dependencyNode={selected ? dependencyGraph.byItemId.get(selected.id) ?? null : null}
      dependencyChoices={dependencyChoices}
      onNavigate={navigateToBacklogItem}
      agentTargets={agentTargets}
      agentSessions={agentSessions}
      onAgentFlyoutOpen={refreshAgentSessions}
      onSendToAgent={(item, sessionId) => void sendItemToAgent(item, sessionId)}
    />
  )

  return (
    <section
      ref={rootRef}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-[color:var(--bg-surface)] text-[color:var(--text-default)]"
      aria-label="Backlog"
    >
      <PanelHeader
        title="Backlog"
        count={filtered.length}
        subtitle={headerScopeLabel}
        primaryAction={newPlanButton}
        overflow={refreshButton}
      />

      <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2">
        <div
          className="flex min-w-0 flex-1 basis-[10rem]"
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
          onViewChange={handleViewChange}
          onSortChange={handleSortChange}
          onGroupChange={handleGroupChange}
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

      {duplicateIdWarnings ? (
        <div className="shrink-0 px-3 py-2">
          <InlineNotice tone="warn">
            {duplicateIdWarnings.length === 1 ? 'A duplicate id' : 'Duplicate ids'} from concurrent edits — resolve by re-allocating one side:
            {duplicateIdWarnings.map((warning) => (
              <span key={warning.label} className="mt-0.5 block font-mono text-[12px] tabular-nums">
                {warning.label}: {warning.paths.join(', ')}
              </span>
            ))}
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
        <div className="flex min-h-0 flex-1 flex-col">
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
          dependencyChoices={dependencyChoices}
          itemActions={menuItemActions}
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
  epicMetaBySlug,
  epicProgressBySlug,
  waitingById,
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
  // slug -> epic identity, for the row tint + the flat-view member chip.
  epicMetaBySlug: ReadonlyMap<string, BacklogEpicMeta>
  // slug -> true full-scan completion, for epic rows and group headers.
  epicProgressBySlug: ReadonlyMap<string, BacklogEpicProgress>
  // Derived "waiting" rows (active + ≥1 unresolved prerequisite). Absent entry =
  // not waiting; the source picker passes none.
  waitingById?: ReadonlyMap<string, true>
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
      className="min-h-0 flex-1 overflow-y-auto py-1 outline-none focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--border-focus)]"
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
                progress={row.group.slug ? epicProgressBySlug.get(row.group.slug) : undefined}
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
                epicMeta={row.item.epic ? epicMetaBySlug.get(row.item.epic) : undefined}
                isWaiting={waitingById?.get(row.item.id)}
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
              // A member row resolves its PARENT epic's identity; an epic row
              // resolves its OWN, so the banner treatment (tinted glyph, meter
              // colour, full-row wash) rides the same prop.
              epicMeta={
                item.epic
                  ? epicMetaBySlug.get(item.epic)
                  : item.isEpic
                    ? epicMetaBySlug.get(epicSlug(item))
                    : undefined
              }
              epicProgress={item.isEpic ? epicProgressBySlug.get(epicSlug(item)) : undefined}
              isWaiting={waitingById?.get(item.id)}
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
  epicMeta,
  epicProgress,
  isWaiting,
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
  // The row's epic identity: a member's parent epic, or an epic row's own.
  // Drives the option-C full-row tint and, in the flat (ungrouped) list, the
  // member's epic chip / the epic's banner treatment.
  epicMeta?: BacklogEpicMeta
  // An epic row's true completion rollup (full scan), for the progress meter.
  epicProgress?: BacklogEpicProgress
  isWaiting?: boolean
}): JSX.Element {
  const archived = item.status === 'archived'
  // Option C: the epic identity colour fills the whole member row (below a
  // hand-set highlight, above the ambient risk heat — see resolveBacklogRowColor).
  const { color: stripeColor, litFill } = resolveBacklogRowColor(item, epicMeta?.color ?? null)
  const swatch = stripeColor ? getHighlightSwatch(stripeColor) : null
  return (
    <li
      id={`backlog-opt-${optionIndex}`}
      role="option"
      aria-selected={selected}
      draggable={Boolean(onItemDragStart)}
      onDragStart={onItemDragStart ? (event) => onItemDragStart(event, item) : undefined}
      onContextMenu={onItemContextMenu ? (event) => onItemContextMenu(event, item) : undefined}
      onClick={() => onSelect(item.id)}
      className={`cursor-pointer border-l-[3px] ${indented ? 'pl-6 pr-3' : 'px-3'} py-1.5 transition-colors ${
        selected
          ? `${swatch ? swatch.border : 'border-l-[color:var(--accent-primary)]'} ${litFill && swatch ? swatch.bg : 'bg-[color:var(--accent-primary-soft)]'} ${indented ? 'pl-[21px]' : 'pl-[9px]'}`
          : `${swatch ? `${swatch.border}${litFill ? ` ${swatch.dimBg}` : ''}` : 'border-l-transparent'} hover:bg-[color:var(--bg-hover)]`
      } ${archived ? 'opacity-70' : ''}`}
    >
      {/* The whole row carries one styled hover card (full title, status, id,
          path) in place of the old native `title` path tooltip. A calm 600ms
          delay so it never flickers while scanning the list; `plainTitle`
          keeps the clipped-title tooltip from stacking a second popover. The
          wrapper is presentational so the listbox's option semantics hold. */}
      <Tooltip
        content={<BacklogRowHoverCard item={item} runGlyph={runGlyph} epicProgress={epicProgress} />}
        placement="top"
        openDelayMs={600}
        wrapperClassName="block"
        wrapperRole="presentation"
      >
        <div>
          <BacklogRowContent
            item={item}
            now={now}
            runGlyph={runGlyph}
            isWaiting={isWaiting}
            epicMeta={indented ? undefined : epicMeta}
            epicProgress={epicProgress}
            plainTitle
          />
        </div>
      </Tooltip>
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
  progress,
}: {
  row: Extract<BacklogGroupedRow, { kind: 'header' }>
  optionIndex: number
  selected: boolean
  onSelect: (id: string) => void
  onToggleCollapse: (group: BacklogEpicGroup) => void
  onItemDragStart?: (event: React.DragEvent<HTMLLIElement>, item: BacklogItem) => void
  onItemContextMenu?: (event: React.MouseEvent, item: BacklogItem) => void
  // True full-scan completion for this group's slug (epic and dangling-slug
  // groups); the no-epic bucket has no slug and keeps the group's own rollup.
  progress?: BacklogEpicProgress
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
        progress={progress}
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
  runGlyphById,
  now,
  hasItems,
  externalActions,
  workspaceId,
  linkProviders,
  showBack,
  onBack,
  actions,
  epicChoices,
  items,
  epicMetaBySlug,
  dependencyNode,
  dependencyChoices,
  onNavigate,
  agentTargets,
  agentSessions,
  onAgentFlyoutOpen,
  onSendToAgent,
}: {
  scan: BacklogScanResult | null
  loading: boolean
  folderPath: string | null
  selected: BacklogItem | null
  selectedRunGlyph?: BacklogRunGlyph
  /** Live run glyph by item id, so an epic's children roll-up can render each
   *  member's real merge state instead of its coarse status tick. */
  runGlyphById?: ReadonlyMap<string, BacklogRunGlyph>
  now: number
  hasItems: boolean
  externalActions: Array<{ action: BacklogItemAction; disabled: boolean; run: () => void }>
  workspaceId: string
  linkProviders: ReadonlyArray<BacklogLinkProvider>
  showBack: boolean
  onBack: () => void
  actions: BacklogActions
  epicChoices: ReadonlyArray<BacklogEpicChoice>
  // The full scan, so an epic's detail can roll up its children and a child's
  // detail can resolve its parent epic for the crumb (both derived, never stored).
  items: BacklogItem[]
  epicMetaBySlug: ReadonlyMap<string, BacklogEpicMeta>
  // The selected item's derived dependency record (T2), or null for an epic /
  // no selection. Drives the Prerequisites/Blocks section + cycle warning.
  dependencyNode: BacklogDependencyNode | null
  dependencyChoices: ReadonlyArray<BacklogDependencyChoice>
  // All detail cross-navigation (epic -> child, child -> epic crumb,
  // prerequisite/blocked links): the target may sit outside the active
  // lens/search, so this must be the widening navigate, never a plain select.
  onNavigate: (itemId: string) => void
  // Send-to-agent, mirrored from the row context menu: the same targets,
  // liveness snapshot, refresh-on-open, and send path, so working from inside
  // an item never requires going back to the list to hand it off.
  agentTargets: Array<AgentState & { cliSessionId: string }>
  agentSessions: TerminalSessionSnapshot[] | null
  onAgentFlyoutOpen: () => void
  onSendToAgent: (item: BacklogItem, sessionId: string) => void
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

  // Epic ⇄ child traversal, both derived from the live scan (never stored):
  //  - parentEpic: a child's epic, resolved to its concept item so the crumb can
  //    navigate up (null for epics and for orphan/dangling-slug items);
  //  - epicChildren: an epic's members, for the roll-up that navigates down;
  //  - currentEpicColor: the epic's `color:` for the picker's selected swatch.
  const isEpic = selected.isEpic
  const parentEpic = !isEpic && selected.epic
    ? items.find((candidate) => candidate.isEpic && epicSlug(candidate) === selected.epic) ?? null
    : null
  const parentEpicColor = parentEpic && selected.epic ? epicMetaBySlug.get(selected.epic)?.color ?? null : null
  const epicChildren = isEpic ? childrenOfEpic(items, epicSlug(selected)) : []
  const currentEpicColor = isEpic ? epicMetaBySlug.get(epicSlug(selected))?.color ?? null : null
  // Full timestamp for the relative-time tooltip ("2h ago" → the actual date).
  const modifiedAbsolute =
    typeof selected.modifiedAt === 'number' && Number.isFinite(selected.modifiedAt)
      ? new Date(selected.modifiedAt).toLocaleString()
      : 'Unknown time'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-[color:var(--border-default)] px-4 py-3">
        {/* Nav + metadata row: the single back affordance leads, then the status
            glyph, id, status word, time, and file path — all the chrome the title
            used to share its line, moved up here so the title below can own a full
            line. The status glyph sits beside the id (its tooltip names the state);
            the time carries the absolute timestamp; the path truncates with its
            own tooltip. */}
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-[color:var(--text-muted)]">
          {showBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to list"
              className="interactive -ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
            >
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}
          <Tooltip
            content={selectedRunGlyph?.label ?? BACKLOG_STATUS_LABEL[selected.status]}
            placement="top"
            wrapperClassName="inline-flex shrink-0"
          >
            <LifecycleGlyph
              state={selectedRunGlyph?.state ?? backlogStatusToLifecycle(selected.status)}
              // Spin only for a genuinely live run — a bare in_progress status
              // has no agent working it, so the arc stays static.
              live={selectedRunGlyph?.live ?? false}
            />
          </Tooltip>
          {selected.displayId ? (
            <>
              <span className="shrink-0 whitespace-nowrap font-mono tabular-nums text-[color:var(--text-subtle)]">
                {selected.displayId}
              </span>
              <span aria-hidden="true" className="shrink-0 text-[color:var(--text-disabled)]">·</span>
            </>
          ) : null}
          {(selectedRunGlyph?.label ?? LIFECYCLE_LABEL[selected.status]) ? (
            <>
              <span className="shrink-0 whitespace-nowrap">
                {selectedRunGlyph?.label ?? LIFECYCLE_LABEL[selected.status]}
              </span>
              <span aria-hidden="true" className="shrink-0 text-[color:var(--text-disabled)]">·</span>
            </>
          ) : null}
          <Tooltip content={modifiedAbsolute} placement="top" wrapperClassName="inline-flex shrink-0">
            <span className="whitespace-nowrap tabular-nums">
              {formatRelativeMsAgo(selected.modifiedAt, now) || 'unknown'}
            </span>
          </Tooltip>
          <span aria-hidden="true" className="shrink-0 text-[color:var(--text-disabled)]">·</span>
          <TruncatedText
            as="span"
            text={selected.relativePath}
            className="min-w-0 flex-1 font-mono tabular-nums"
          />
        </div>
        {/* The title is the header's one clear priority: a full-width line of its
            own (no glyph, no back button) that wraps to two lines and reveals the
            full text in a tooltip when clamped. */}
        <TruncatedText
          as="h3"
          multiline
          text={selected.title}
          placement="bottom"
          className="mt-1.5 line-clamp-2 text-[14px] font-semibold leading-snug text-[color:var(--text-strong)]"
        />
        {/* Child → epic link: a plain link up to the parent epic (no back arrow —
            it navigates sideways to a sibling concept, not "back"). Carries the
            epic's identity colour, and its full name in a tooltip when clipped. */}
        {parentEpic ? (
          <button
            type="button"
            onClick={() => onNavigate(parentEpic.id)}
            aria-label={`Open epic ${parentEpic.title}`}
            className="interactive mt-1.5 -ml-1.5 flex max-w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-[11.5px] font-medium text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            <EpicColorDot color={parentEpicColor} size={7} />
            <TruncatedText as="span" text={parentEpic.title} className="min-w-0" />
          </button>
        ) : null}

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
          <OverflowMenu
            ariaLabel="More actions"
            triggerTooltip="More actions"
            items={[
              // The file-navigation actions were on their own buttons; folded in
              // here they free the row down to the primary action + this menu.
              { id: 'open-in-editor', label: 'Open in editor', onSelect: () => actions.openInEditor(selected) },
              { id: 'reveal-in-files', label: 'Reveal in Files', onSelect: () => actions.revealInFiles(selected) },
              // Same Send-to-agent flyout as the row's right-click menu (shared
              // choice list, liveness refresh on open, shared send path), so an
              // item can be handed off from inside its detail too.
              {
                kind: 'flyout' as const,
                id: 'send-to-agent',
                label: 'Send to agent',
                ariaLabel: 'Send to agent',
                surfaceClassName: 'min-w-[200px]',
                onOpenChange: (open: boolean) => {
                  if (open) onAgentFlyoutOpen()
                },
                render: (close: () => void) => (
                  <AgentTargetMenuItems
                    agentTargets={agentTargets}
                    agentSessions={agentSessions}
                    onPick={(sessionId) => {
                      onSendToAgent(selected, sessionId)
                      close()
                    }}
                  />
                ),
              },
              { kind: 'separator' as const, id: 'sep-files' },
              // Triage editors, moved out of the detail body into flyout submenus
              // so the pane opens straight to content. Same choice lists, checks,
              // and handlers as the row's right-click menu — each choice applies
              // then closes the whole menu.
              {
                kind: 'flyout' as const,
                id: 'set-status',
                label: 'Status',
                ariaLabel: 'Set status',
                surfaceClassName: 'min-w-[180px]',
                render: (close: () => void) =>
                  STATUS_MENU_CHOICES.map((status) => (
                    <MenuItem
                      key={status}
                      checked={selected.status === status}
                      icon={<MenuCheckGlyph visible={selected.status === status} />}
                      onClick={() => {
                        actions.setStatus(selected, status)
                        close()
                      }}
                    >
                      {BACKLOG_STATUS_LABEL[status]}
                    </MenuItem>
                  )),
              },
              {
                kind: 'flyout' as const,
                id: 'set-priority',
                label: 'Priority',
                ariaLabel: 'Set priority',
                surfaceClassName: 'min-w-[180px]',
                render: (close: () => void) =>
                  CRITICALITY_EDIT_ITEMS.map(({ value, label }) => (
                    <MenuItem
                      key={value}
                      checked={(selected.criticality ?? 'unset') === value}
                      icon={<MenuCheckGlyph visible={(selected.criticality ?? 'unset') === value} />}
                      onClick={() => {
                        actions.setCriticality(selected, value)
                        close()
                      }}
                    >
                      {label}
                    </MenuItem>
                  )),
              },
              {
                kind: 'flyout' as const,
                id: 'set-size',
                label: 'Size',
                ariaLabel: 'Set size',
                surfaceClassName: 'min-w-[180px]',
                render: (close: () => void) =>
                  DIFFICULTY_EDIT_ITEMS.map(({ value, label }) => (
                    <MenuItem
                      key={value}
                      checked={(selected.difficulty ?? 'unset') === value}
                      icon={<MenuCheckGlyph visible={(selected.difficulty ?? 'unset') === value} />}
                      onClick={() => {
                        actions.setDifficulty(selected, value)
                        close()
                      }}
                    >
                      {label}
                    </MenuItem>
                  )),
              },
              {
                kind: 'flyout' as const,
                id: 'set-risk',
                label: 'Risk',
                ariaLabel: 'Set risk',
                surfaceClassName: 'min-w-[180px]',
                render: (close: () => void) =>
                  RISK_EDIT_ITEMS.map(({ value, label }) => (
                    <MenuItem
                      key={value}
                      checked={(selected.risk ?? 'unset') === value}
                      icon={<MenuCheckGlyph visible={(selected.risk ?? 'unset') === value} />}
                      onClick={() => {
                        actions.setRisk(selected, value)
                        close()
                      }}
                    >
                      {label}
                    </MenuItem>
                  )),
              },
              { kind: 'separator' as const, id: 'sep-triage' },
              ...(selected.status !== 'archived' && selected.status !== 'completed'
                ? [{ id: 'mark-completed', label: 'Mark completed', onSelect: () => actions.setStatus(selected, 'completed') }]
                : []),
              ...(primaryRunLink
                ? [{ id: 'unlink-sprint', label: 'Unlink sprint…', onSelect: () => actions.removeLink(selected, primaryRunLink) }]
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
              // An epic carries an identity colour; it rides here as a swatch row
              // (same control as the row's Highlight colour) instead of a section
              // in the body, so the epic detail opens straight to its children.
              ...(selected.isEpic
                ? [
                    {
                      kind: 'swatch' as const,
                      id: 'epic-color',
                      label: 'Epic color',
                      value: currentEpicColor,
                      onPick: (color: BacklogHighlightColor) => actions.setEpicColor(selected, color),
                      onClear: () => actions.setEpicColor(selected, null),
                    },
                  ]
                : []),
              { id: 'rename', label: 'Rename…', onSelect: () => actions.rename(selected) },
              ...(selected.status === 'archived'
                ? []
                : selected.isEpic
                  ? [{ id: 'archive-epic', label: 'Archive epic', onSelect: () => actions.archiveEpic(selected) }]
                  : [{ id: 'archive', label: 'Archive', onSelect: () => actions.archive(selected) }]),
              { kind: 'separator' as const, id: 'sep' },
              { id: 'delete', label: 'Delete…', destructive: true, onSelect: () => actions.remove(selected) },
            ]}
          />
        </div>
      </header>

      {/* Only the identity header stays pinned. The metadata sections (Links,
          Triage, Dependencies, epic roll-up) and the body all scroll together,
          so they don't permanently consume the viewport above the item text. */}
      <div className="min-h-0 flex-1 overflow-auto">
        {/* Epic-only: the navigable children roll-up leads the detail, since it is
            the epic's primary content (the identity colour moved to the header's
            More-actions menu). The shared Links + Triage sections still follow for
            every item (Triage hides its Epic select for an epic — epics do not
            nest). */}
        {isEpic ? (
          <BacklogEpicChildren
            members={epicChildren}
            color={currentEpicColor}
            runGlyphById={runGlyphById}
            onNavigate={onNavigate}
          />
        ) : null}

        <BacklogLinksSection
          item={selected}
          workspaceId={workspaceId}
          workspaceRoot={folderPath}
          providers={linkProviders}
          epicChildStatuses={isEpic ? epicChildren.map((child) => child.status) : undefined}
          excludeLinkId={primaryRunLinkId}
          onRemoveLink={(link) => actions.removeLink(selected, link)}
        />

        <BacklogTriage item={selected} actions={actions} epicChoices={epicChoices} />

        {!selected.isEpic ? (
          <BacklogDependenciesSection
            item={selected}
            node={dependencyNode}
            dependencyChoices={dependencyChoices}
            actions={actions}
            onNavigate={onNavigate}
          />
        ) : null}

        <div className="px-4 py-3">
          <BacklogPreviewBody item={selected} />
        </div>
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

// An epic has no Sprint Engine run link of its own, so its detail header would
// otherwise fall back to its coarse `completed` status — the green tick — even
// when every member's sprint run has merged. Roll the members' real run states
// up into the epic's own glyph so a merged epic reads "Merged" (purple branch)
// once its children's PRs land, matching what each member shows in the list.
// Returns undefined when there is no run signal to project — no run-linked
// member, or active work still in flight — so the epic's own status renders.
function deriveEpicRunGlyphFromChildren(
  epic: BacklogItem,
  items: BacklogItem[],
  runGlyphById: ReadonlyMap<string, BacklogRunGlyph>,
): BacklogRunGlyph | undefined {
  const children = childrenOfEpic(items, epicSlug(epic)).filter((child) => child.status !== 'archived')
  if (children.length === 0) return undefined
  let sawMerged = false
  let sawUnmerged = false
  for (const child of children) {
    const state = runGlyphById.get(child.id)?.state ?? backlogStatusToLifecycle(child.status)
    if (state === 'done_merged') {
      sawMerged = true
    } else if (state === 'done_unmerged') {
      sawUnmerged = true
    } else if (state !== 'done') {
      // A member still in flight (or not yet started): the epic isn't complete,
      // so don't project a merge glyph — defer to the epic's own status.
      return undefined
    }
  }
  if (sawUnmerged) return { state: 'done_unmerged', live: false, label: 'Ready for review' }
  if (sawMerged) return { state: 'done_merged', live: false, label: 'Merged' }
  // All members plain `done` (on-main, no sprint run): no merge signal to project.
  return undefined
}

// Epic -> children roll-up (epic detail only): a flat done/total progress track
// in the epic's identity colour, then each member as a navigable row (status
// glyph + title + size + priority). Selecting a row drives onNavigate so the
// list moves to that child — the inverse of the child's parent-epic crumb —
// widening the lens when the child is hidden by it (a completed child under the
// Active lens). The children query is derived from the live scan on every
// render, never stored.
function BacklogEpicChildren({
  members,
  color,
  runGlyphById,
  onNavigate,
}: {
  members: BacklogItem[]
  color: BacklogHighlightColor | null
  runGlyphById?: ReadonlyMap<string, BacklogRunGlyph>
  onNavigate: (id: string) => void
}): JSX.Element {
  const total = members.length
  const done = members.reduce((count, child) => (child.status === 'completed' ? count + 1 : count), 0)
  const fillColor = color ? getHighlightSwatch(color).hex : 'var(--accent-primary)'
  return (
    <Section
      title="Children"
      level={4}
      inset
      count={total > 0 ? total : undefined}
      className="shrink-0 border-b border-[color:var(--border-subtle)] pb-3"
    >
      {total === 0 ? (
        <p className="px-3 text-[12px] text-[color:var(--text-disabled)]">
          No items in this epic yet. Assign items from their “Move to epic” menu.
        </p>
      ) : (
        <div className="px-3">
          <div className="mb-2 flex items-center justify-between text-[11px] text-[color:var(--text-muted)]">
            <span className="tabular-nums">{done} of {total} done</span>
          </div>
          <div className="mb-2.5 h-[3px] overflow-hidden rounded-full bg-[color:var(--bg-active)]" role="presentation">
            <span
              className="block h-full rounded-full"
              style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%`, backgroundColor: fillColor }}
            />
          </div>
          <ul className="flex flex-col">
            {members.map((child) => {
              // A member linked to a Sprint Engine run shows the runner's real
              // state here — the purple "Merged" branch once its PR lands — not
              // the coarse completed tick, matching how the same item reads in
              // the list and the epic header.
              const glyph = runGlyphById?.get(child.id)
              return (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => onNavigate(child.id)}
                  title={child.relativePath}
                  className="interactive flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-[color:var(--bg-hover)]"
                >
                  <Tooltip content={glyph?.label ?? BACKLOG_STATUS_LABEL[child.status]} placement="top">
                    <LifecycleGlyph
                      state={glyph?.state ?? backlogStatusToLifecycle(child.status)}
                      // The spinner means "an agent is working on this right
                      // now": only a live run glyph earns it; a bare
                      // in_progress status renders the static quarter arc.
                      live={glyph?.live ?? false}
                    />
                  </Tooltip>
                  {child.displayId ? (
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-[color:var(--text-subtle)]">
                      {child.displayId}
                    </span>
                  ) : null}
                  <TruncatedText
                    as="span"
                    text={child.title}
                    className={`min-w-0 flex-1 text-[12px] ${
                      child.status === 'completed' ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-default)]'
                    }`}
                  />
                  <DifficultyIndicator difficulty={child.difficulty} />
                  <CriticalityIndicator criticality={child.criticality} />
                </button>
              </li>
              )
            })}
          </ul>
        </div>
      )}
    </Section>
  )
}

// Selecting "Unestimated" / "No priority" / "No risk set" clears the axis back
// to neutral. Risk is the likelihood the work goes sideways — distinct from
// effort and impact — and feeds the Best sort and the row's derived heat color.
// Epic assignment is search-first, matching the row menu instead of opening the
// full epic catalogue; epic items cannot nest, so the control stays hidden.
function BacklogTriage({
  item,
  actions,
  epicChoices,
}: {
  item: BacklogItem
  actions: BacklogActions
  epicChoices: ReadonlyArray<BacklogEpicChoice>
}): JSX.Element | null {
  // Size / Priority / Risk / Status now live in the header's More-actions menu
  // (flyout submenus), so the only editor left in the body is epic membership.
  // Epics don't nest, so an epic item has no membership control and the section
  // renders nothing at all.
  if (item.isEpic) return null
  return (
    <Section title="Epic" level={4} inset className="shrink-0 border-b border-[color:var(--border-subtle)] pb-3">
      <div className="grid grid-cols-[3.5rem_minmax(0,16rem)] items-center gap-x-3 gap-y-2 px-3">
        <span className="text-[11px] text-[color:var(--text-muted)]">Epic</span>
        <BacklogEpicSearchEditor item={item} actions={actions} epicChoices={epicChoices} />
      </div>
    </Section>
  )
}

function BacklogEpicSearchEditor({
  item,
  actions,
  epicChoices,
}: {
  item: BacklogItem
  actions: BacklogActions
  epicChoices: ReadonlyArray<BacklogEpicChoice>
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const current = epicChoices.find((epic) => epic.slug === item.epic)
  const currentLabel = current?.title ?? (item.epic ? `${item.epic} (missing)` : 'No epic')

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Move to epic"
      popupRole="dialog"
      className="w-full"
      placement="bottom-start"
      surfaceClassName="min-w-[19rem] p-1"
      renderTrigger={({ ref, togglePopover, triggerProps }) => (
        <button
          ref={ref}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={triggerProps['aria-expanded']}
          aria-controls={triggerProps['aria-controls']}
          aria-label="Move to epic"
          onClick={togglePopover}
          className="interactive inline-flex h-7 w-full min-w-[140px] items-center justify-between gap-2 rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 text-left text-[12px] text-[color:var(--text-default)] hover:border-[color:var(--border-strong)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--border-strong)]"
        >
          <span className="min-w-0 flex-1 truncate">{currentLabel}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="shrink-0 text-[color:var(--text-muted)]">
            <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    >
      <BacklogItemSearchPicker
        options={epicChoices.map((epic) => ({
          id: epic.slug,
          value: epic.slug,
          title: epic.title,
          displayId: epic.displayId,
          searchText: epic.slug,
        }))}
        selectedValues={item.epic ? [item.epic] : []}
        ariaLabel="Search epics"
        placeholder="Search epic ID or name…"
        noOptionsMessage="No epics yet."
        resultRole="listbox"
        onSelect={(epic) => {
          actions.setEpic(item, epic.value)
          setOpen(false)
        }}
      />
      <div className="border-t border-[color:var(--border-subtle)] pt-1">
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            actions.createEpic(item)
          }}
          className="interactive w-full rounded px-2.5 py-1.5 text-left text-[12px] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
        >
          New epic…
        </button>
        {item.epic ? (
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              actions.setEpic(item, null)
            }}
            className="interactive w-full rounded px-2.5 py-1.5 text-left text-[12px] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            Remove from epic
          </button>
        ) : null}
      </div>
    </Popover>
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
    item.excerpt.toLowerCase().includes(query) ||
    (item.displayId?.toLowerCase().includes(query) ?? false) ||
    (typeof item.numericId === 'number' && String(item.numericId).includes(query))
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
