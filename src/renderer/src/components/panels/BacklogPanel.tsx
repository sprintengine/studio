import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  backlogOrWorkspacePath,
  backlogRootOf,
  ensureBacklogRoot,
  forgetBacklogLocation,
} from '../../hooks/backlogLocation'

import {
  EmptyState,
  GhostButton,
  IconButton,
  InboxSearchInput,
  InlineNotice,
  LifecycleGlyph,
  MenuItem,
  OverflowMenu,
  Popover,
  PrimaryButton,
  RefreshIcon,
  RowButton,
  Section,
  Skeleton,
  Tooltip,
  TriggerButton,
  TruncatedText,
  useConfirmDialog,
  type OverflowMenuItem,
  type SelectItem,
} from '../ui'
import { useShallow } from 'zustand/react/shallow'
import type { AgentState } from '../../types/workspace'
import type { BacklogLocationInfo } from '../../../../shared/electron-api'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { selectBacklogProjectView, useBacklogViewStore } from '../../store/backlogViewStore'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { useSharedBacklogScan } from '../../hooks/useSharedBacklogScan'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import { renderMarkdown } from '../../utils/markdown'
import { basename, parentPath, slugify } from '../../utils/paths'
import { isEditableTarget } from '../../utils/keyboard'
import { resolveFirstMockupCandidate } from '../../utils/backlogMockups'
import { HtmlArtifactFrame } from '../htmlArtifact/HtmlArtifactFrame'
import { focusOrAddFileTab, remapFileTabsForPath, removeFileTabsForPath } from '../../utils/modelRegistry'
import { sendFileDropToTerminal, setFileDropData, type FileDropPayload } from '../../utils/terminalDrop'
import { recordBacklogAgentHandoff } from '../../utils/backlogAgentHandoff'
import { canHandBacklogItemToAgent } from '../../utils/backlogHandoff'
import { hasAgentLink } from '../../utils/agentBacklogLinks'
import { consumePendingBacklogReveal, subscribeBacklogReveal } from '../../utils/backlogReveal'
import { findDuplicateBacklogIds } from '../../../../shared/backlog/item-id'
import {
  backlogItemSlugFromPath,
  backlogPreviewMarkdown,
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
import { backlogItemWithoutRetiredLinks, nextBacklogItemStatusFromLinks } from '../../utils/backlogLinks'
import { BacklogHandToAgentButton, BacklogOpenAgentButton } from '../backlog/BacklogHandToAgentButton'
import { overflowItemsForBacklogModuleActions } from '../backlog/backlogModuleActions'
import { BacklogLinksSection } from '../backlog/BacklogLinksSection'
import { BacklogDependenciesSection } from '../backlog/BacklogDependenciesSection'
import { BacklogMockupsSection } from '../backlog/BacklogMockupsSection'
import { FilePreviewPane } from '../ui/FilePreviewPane'
import { BacklogItemSearchPicker } from '../backlog/BacklogItemSearchPicker'
import { isRoadmapContent } from '../../../../shared/backlog/roadmap'
import { BacklogFilterMenu } from '../backlog/BacklogFilterMenu'
import {
  collapseBacklogSelectionTo,
  effectiveBacklogSelection,
  extendBacklogSelectionTo,
  pruneBacklogSelection,
  toggleBacklogSelection,
  EMPTY_BACKLOG_MULTI_SELECTION,
} from '../backlog/backlogMultiSelection'
import { backlogRowPaintClass } from '../backlog/backlogRowPaint'
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
import {
  backlogDependencyState,
  deriveBacklogDependencies,
  epicBlockedRollupBySlug,
  type BacklogDependencyNode,
  type BacklogDependencyState,
  type BacklogEpicBlockedRollup,
} from '../../utils/backlogDependencies'
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
  BACKLOG_BLOCKED_LABEL,
  BACKLOG_STATUS_LABEL,
  backlogStatusToLifecycle,
  CriticalityIndicator,
  DifficultyIndicator,
  EpicColorDot,
  EpicProgressMeter,
} from '../backlog/BacklogRow'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import type {
  BacklogItemAction,
  BacklogItemActionContext,
  BacklogLinkProvider,
  WorkspacePanelProps,
} from '../../modules/renderer-host'

// Backlog panel: capture / browse / triage / start surface for the lightweight
// items (rough ideas, notes, feature sketches, imported markdown, mockups)
// under the workspace `backlog/` folder. File mutations stay on existing
// filesystem IPC; triage metadata (size / priority) is owned in the backlog
// object store (items.json), never markdown frontmatter.
//
// Follows design-system/foundations/principles.md:
// stripless nav-pane sibling of Files/Git/KG, one accent, hairline structure.
// Triage reads as Shared meta — a t-shirt size token and a shape-coded
// priority glyph+word — not as a per-row status dot. Unestimated is a calm
// neutral, never a "needs structure" warning.

// The row-level action vocabulary (BacklogActions), the size/priority choice
// lists, and the row context menu live in ../backlog/BacklogItemContextMenu so
// the panel composes them rather than hosting another ~250 lines of menu UI.

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
  { value: 'recent', label: 'Updated at' },
  { value: 'created', label: 'Created at' },
  { value: 'status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'largest', label: 'Largest first' },
  { value: 'smallest', label: 'Smallest first' },
  { value: 'dependency', label: 'Dependency order' },
  { value: 'no_epic', label: 'No epic first' },
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
  // "Epics" is the name of the lens, not a common noun, so it keeps the capital
  // it carries in the filter menu that switched it on.
  epics: 'Epics',
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

export default function BacklogPanel({ workspaceId }: WorkspacePanelProps): JSX.Element {
  const folderPath = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.folderPath ?? null,
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
  // The extended (shift/cmd) selection layered over the cursor above,
  // keyed by item id.
  const [multiSelection, setMultiSelection] = useState(EMPTY_BACKLOG_MULTI_SELECTION)
  // Search is ephemeral: a transient act, never persisted or shared, so each
  // window's box starts empty and typing here never leaks to another workspace.
  const [search, setSearch] = useState('')
  // The lens/sort/grouping are PROJECT-scoped (shared + live-synced across every
  // workspace on this project) via the backlog view store, so the backlog reads
  // as one list per project instead of diverging per window. Reading through a
  // useShallow selector keeps re-renders to actual value changes.
  const { view, sort, group } = useBacklogViewStore(useShallow((state) => selectBacklogProjectView(state, folderPath)))
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
  // `selection`: opened on a row inside a live multi-selection, so module
  // actions act on the whole selection rather than the row alone.
  const [rowMenu, setRowMenu] = useState<{ itemId: string; x: number; y: number; selection?: boolean } | null>(null)
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

  // Where this workspace's backlog lives, for the empty state to speak
  // accurately: "there is no folder yet" and "the folder you chose is not there"
  // are different problems with different fixes, and showing the second as the
  // first reads as lost work.
  const [backlogLocation, setBacklogLocationInfo] = useState<BacklogLocationInfo | null>(null)
  const refreshBacklogLocation = useCallback(async () => {
    if (!folderPath) {
      setBacklogLocationInfo(null)
      return
    }
    const resolved = await window.api.resolveBacklogLocation(folderPath).catch(() => null)
    setBacklogLocationInfo(resolved?.ok ? resolved.location : null)
  }, [folderPath])
  useEffect(() => {
    void refreshBacklogLocation()
  }, [refreshBacklogLocation, scan])

  // The shared store returns scan=null for a missing folder; mirror the old
  // behavior of clearing the local selection/detail view in that case.
  useEffect(() => {
    if (folderPath) return
    setSelectedId(null)
    setShowDetailInSingle(false)
  }, [folderPath])

  // An epic's status is derived UP from its children at READ time, never read from
  // its own frontmatter `status:` (which stays meaningful only for archival) and
  // never written back by the link sync (backlog/2026-07-15-backlog-epic-
  // status-derives-from-children.md). Deriving it here, once over the full scan,
  // means every downstream surface — rows, detail, lens filtering, the dependency
  // graph and sort order — reads the corrected status with no
  // special-casing. Leaf items pass through untouched, so their behavior is
  // byte-identical. A never-launched epic (zero links) still derives from its
  // children; a childless epic falls back to the leaf link rule.
  //
  // Links from retired modules (the removed Sprint Engine) are dropped here too,
  // so no surface below renders or derives from them.
  const items = useMemo(() => {
    const raw = (scan?.items ?? []).map(backlogItemWithoutRetiredLinks)
    if (!raw.some((item) => item.isEpic)) return raw
    const childStatusesBySlug = new Map<string, BacklogItemStatus[]>()
    for (const item of raw) {
      if (item.isEpic || !item.epic) continue
      const bucket = childStatusesBySlug.get(item.epic)
      if (bucket) bucket.push(item.status)
      else childStatusesBySlug.set(item.epic, [item.status])
    }
    return raw.map((item) => {
      if (!item.isEpic) return item
      const derived = nextBacklogItemStatusFromLinks(
        item.status,
        item.links,
        childStatusesBySlug.get(epicSlug(item)) ?? [],
      )
      return derived === item.status ? item : { ...item, status: derived }
    })
  }, [scan])

  // The dependency graph (T2) is derived once over the FULL item set — never the
  // filtered view — so prerequisite resolution and the waiting signal stay
  // accurate regardless of the active lens (a prerequisite hidden by a filter
  // still resolves to its real status). Recomputed only when the scan changes,
  // like runGlyphById. Feeds the waiting badges, the detail Prerequisites/Blocks
  // section, and the "Dependency order" sort.
  const dependencyGraph = useMemo(() => deriveBacklogDependencies(items), [items])
  // slug -> granular blocked rollup for epics ("N of remaining children
  // blocked"), and item id -> the derived dependency marker every rendering
  // surface shares: 'blocked' replaces the Ready presentation (a stored `ready`
  // with unresolved prerequisites — or an epic whose EVERY remaining child is
  // blocked); 'waiting' is the softer badge for other gated active items.
  // Derived per scan, never persisted. `blockedPaths` mirrors the blocked ids
  // by relativePath for the comparator, whose Triageable view carries no id.
  const epicBlockedBySlug = useMemo(() => epicBlockedRollupBySlug(dependencyGraph), [dependencyGraph])
  const { dependencyStateById, blockedPaths } = useMemo(() => {
    const stateById = new Map<string, BacklogDependencyState>()
    const blocked = new Set<string>()
    for (const node of dependencyGraph.nodes) {
      const state = backlogDependencyState(node, node.item.isEpic ? epicBlockedBySlug.get(node.slug) : undefined)
      if (!state) continue
      stateById.set(node.item.id, state)
      if (state === 'blocked') blocked.add(node.item.relativePath)
    }
    return { dependencyStateById: stateById, blockedPaths: blocked }
  }, [dependencyGraph, epicBlockedBySlug])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    const matched = items.filter((item) => {
      // Roadmap objects live in the backlog store (backlog/roadmaps/) but are
      // not backlog work items: they are ordered plans, authored as files. The
      // door that steered them retired on 2026-09-05, so nothing renders them
      // as a surface any more — but listing them here would read as
      // project-scoped items with MC ids, which they are not. They stay in
      // `items` so navigation/reveal still opens the authoring editor.
      if (isRoadmapContent(item.relativePath, item.rawType)) return false
      // Files under backlog/mockups/ are attachments other items reference via
      // `mockups:` frontmatter, not work items — listing them here gave them
      // MC-id-looking rows. Full substrate fix (markdown-only objects)
      // will retire their item-hood; until then they are hidden, not gone, so
      // the handoff flows keep resolving them.
      if (item.relativePath.startsWith('backlog/mockups/')) return false
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
    // The status and best sorts demote derived-blocked items (they cannot be
    // acted on); the accessor keys off relativePath, the one identity field the
    // comparator's Triageable view carries.
    return matched.sort((a, b) => compareBacklogItems(a, b, sort, (entry) => blockedPaths.has(entry.relativePath)))
  }, [items, search, view, sort, dependencyGraph, blockedPaths])

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
      const defaultCollapsed = (view === 'archived' || view === 'completed') && epicGroup.kind === 'epic'
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
  // The VISIBLE item rows in nav order — headers excluded — which is the space
  // shift ranges walk. A collapsed group's children are not rangeable (they are
  // not on screen) but stay selected: pruning uses `filtered`, like the cursor.
  const itemIdOrder = useMemo<string[]>(
    () =>
      groupedRows
        ? groupedRows.filter((row) => row.kind === 'item').map((row) => row.item.id)
        : filtered.map((item) => item.id),
    [groupedRows, filtered],
  )

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
  // The extended selection prunes against `filtered` (like the cursor), so a
  // collapsed group hides its selected rows without dropping them.
  useEffect(() => {
    setMultiSelection((prev) => pruneBacklogSelection(prev, new Set(filtered.map((item) => item.id))))
  }, [filtered])

  const selected = useMemo(() => filtered.find((item) => item.id === selectedId) ?? null, [filtered, selectedId])
  // During a multi-selection the detail pane binds to the anchor (last-clicked)
  // row rather than the roving range end; single mode keeps the cursor binding.
  const detailItem = useMemo(() => {
    if (!multiSelection.keys) return selected
    const anchor = multiSelection.anchorKey
      ? (filtered.find((item) => item.id === multiSelection.anchorKey) ?? null)
      : null
    return anchor ?? selected
  }, [multiSelection, filtered, selected])
  // What the list paints as selected: the multi set, else the cursor row.
  const selectedRowIds = useMemo(
    () => effectiveBacklogSelection(multiSelection, selectedId),
    [multiSelection, selectedId],
  )

  // Inline mockup preview: when set, the detail pane renders the
  // rendered mockup in a FilePreviewPane in place of the item content. Cleared
  // whenever the selected item changes (below) and on back/close, so a preview
  // never bleeds across items.
  const [previewedMockup, setPreviewedMockup] = useState<{
    path: string
    absolutePath: string
    relativePath: string
    content: string
  } | null>(null)
  useEffect(() => {
    setPreviewedMockup(null)
  }, [selectedId])

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
  const [pendingReveal, setPendingReveal] = useState<string | null>(() => consumePendingBacklogReveal(workspaceId))
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
    const item = items.find((candidate) => candidate.relativePath.replace(/\\/g, '/').toLowerCase() === wanted)
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
    const item = items.find((candidate) => candidate.relativePath.replace(/\\/g, '/').toLowerCase() === wanted)
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
    const hasRecord = Boolean(useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.backlogState)
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

  // Shift+↑/↓ extends the selection from the roving cursor: the range end walks
  // the VISIBLE item rows (group headers are skipped — they are not selectable
  // work). Only meaningful when the cursor sits on an item row.
  const extendSelectionByStep = useCallback(
    (direction: 1 | -1) => {
      if (!selectedId || isBacklogHeaderNavId(selectedId)) return
      const currentIndex = itemIdOrder.indexOf(selectedId)
      if (currentIndex < 0) return
      const target = itemIdOrder[currentIndex + direction]
      if (target == null) return
      setMultiSelection((prev) => extendBacklogSelectionTo(prev, selectedId, target, itemIdOrder))
      setSelectedId(target)
    },
    [selectedId, itemIdOrder],
  )

  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLUListElement>) => {
      if (isEditableTarget(event.target)) return
      const currentIndex = selectedId ? navOrder.indexOf(selectedId) : -1
      const currentRow = selectedId ? rowByNavId.get(selectedId) : undefined
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        if (event.shiftKey) {
          extendSelectionByStep(1)
          return
        }
        setMultiSelection((prev) =>
          prev.keys === null && prev.anchorKey === null ? prev : collapseBacklogSelectionTo(null),
        )
        selectAt(currentIndex < 0 ? 0 : Math.min(currentIndex + 1, navOrder.length - 1))
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (event.shiftKey) {
          extendSelectionByStep(-1)
          return
        }
        setMultiSelection((prev) =>
          prev.keys === null && prev.anchorKey === null ? prev : collapseBacklogSelectionTo(null),
        )
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
        setMultiSelection(EMPTY_BACKLOG_MULTI_SELECTION)
      }
    },
    [navOrder, rowByNavId, selectAt, selectedId, toggleGroupCollapsed, extendSelectionByStep],
  )

  // Plain click collapses to single (today's behavior, including the single-
  // column detail flip); cmd/ctrl toggles the row; shift ranges from the
  // anchor. The two multi gestures keep the list face — flipping to the detail
  // on every toggle would end the selection gesture it is part of.
  const handleSelectRow = useCallback(
    (id: string, modifiers?: { toggle?: boolean; range?: boolean }) => {
      setSelectedId(id)
      // Only visible item rows join a multi-selection; an epic group header
      // (which selects its epic item while the epic renders as a header) stays
      // single-select, exactly like the door's headers.
      const selectable = itemIdOrder.includes(id)
      if (modifiers?.range && selectable) {
        setMultiSelection((prev) => extendBacklogSelectionTo(prev, selectedId, id, itemIdOrder))
        return
      }
      if (modifiers?.toggle && selectable) {
        setMultiSelection((prev) => toggleBacklogSelection(prev, selectedId, id))
        return
      }
      setMultiSelection(collapseBacklogSelectionTo(selectable ? id : null))
      setShowDetailInSingle(true)
    },
    [selectedId, itemIdOrder],
  )

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

  // The member row's epic pill navigates by slug (the pill's meta carries no
  // item id); resolving here keeps the pill purely presentational.
  const navigateToEpicBySlug = useCallback(
    (slug: string) => {
      const epic = items.find((candidate) => candidate.isEpic && epicSlug(candidate) === slug)
      if (epic) navigateToBacklogItem(epic.id)
    },
    [items, navigateToBacklogItem],
  )

  // ---- file actions (all via existing window.api fs IPC). Failures surface as
  // a visible, actionable error and leave selection consistent. ----

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

  // Resolve + read the mockup, then swap the detail pane to its rendered preview
  // Resolution re-runs across both tolerated roots from the
  // authored ref (not just the path the section optimistically passed while its
  // async existence check was still pending), so an open is always correct. A
  // missing/unreadable file leaves the preview closed rather than opening an
  // empty frame.
  const openMockupPreview = useCallback(
    (target: { path: string; relativePath: string; absolutePath: string }) =>
      void runAction(async () => {
        if (!folderPath) return
        const found = await resolveFirstMockupCandidate(target.path, async (relativePath) => {
          const absolutePath = await backlogOrWorkspacePath(folderPath, relativePath)
          if (!(await window.api.pathExists(absolutePath))) return null
          return { relativePath, absolutePath, content: await window.api.readfile(absolutePath) }
        })
        if (found) setPreviewedMockup({ path: target.path, ...found })
      }),
    [folderPath, runAction],
  )

  const createBacklogFolder = useCallback(
    () =>
      runAction(async () => {
        if (!folderPath) return
        await ensureBacklogRoot(folderPath)
        await runScan()
      }),
    [folderPath, runAction, runScan],
  )

  // Point this workspace's backlog at a folder anywhere on this machine, or put
  // it back to `<workspace>/backlog`. Both drop the renderer's cached location
  // before rescanning — without that the next scan would read the old root, and
  // the change would appear to have done nothing until the window reloaded.
  const applyBacklogRoot = useCallback(
    (nextRoot: string | null) =>
      runAction(async () => {
        if (!folderPath) return
        const result = await window.api.setBacklogRoot({ workspaceRoot: folderPath, root: nextRoot })
        if (!result.ok) throw new Error(result.message)
        forgetBacklogLocation(folderPath)
        await refreshBacklogLocation()
        await runScan()
      }),
    [folderPath, refreshBacklogLocation, runAction, runScan],
  )

  const chooseBacklogFolder = useCallback(
    () =>
      void (async () => {
        const picked = await window.api.openDir()
        if (!picked) return
        await applyBacklogRoot(picked)
      })(),
    [applyBacklogRoot],
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
        `${todayPrefix()}-${planSlug(title)}`,
        new Set((scan?.items ?? []).map((item) => item.relativePath.toLowerCase())),
      )
      // ensureDir is idempotent; it also covers a missing backlog/ folder.
      const backlogDir = await ensureBacklogRoot(folderPath)
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

  // The Backlog carries no door into the roadmap files under backlog/roadmaps/.
  // The instance-global Roadmap door that steered them retired on 2026-09-05;
  // the header space is worth more as the refresh affordance than as a second
  // route to an editor the rows already open.

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
      const archivedDir = await window.api.ensureDir(await backlogRootOf(folderPath), 'archived')
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
          body: `“${item.title}” will be moved to the trash. This affects the file only.`,
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
            body: `Setting “${BACKLOG_STATUS_LABEL[status]}” will unlink ${executionLinks.length === 1 ? 'the linked execution' : `${executionLinks.length} linked executions`}. The linked work itself is not deleted.`,
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
          body: 'This removes only the Backlog association. The linked agent or external target will not be deleted.',
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

  // Mockup attachments are the item's `mockups:` frontmatter only
  // (backlog:update-mockups rewrites the markdown via the shared serializer;
  // items.json is untouched). The full path list is rewritten each attach/remove;
  // null / empty clears the line. The service validates/dedupes, so the UI just
  // sends the next set and re-scans (the fs watcher refreshes the item).
  const setItemMockups = useCallback(
    (item: BacklogItem, mockups: string[] | null) =>
      runAction(async () => {
        if (!folderPath) return
        const updated = await window.api.updateBacklogMockups({
          workspaceRoot: folderPath,
          relativePath: item.relativePath,
          mockups,
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

  // Refresh sits in this menu rather than beside the plus: the band carries
  // ONE primary action, and stacking a second glyph beside it is what gave
  // every panel a different action cluster (2112). Creating an item is the
  // action the panel exists for, so the plus keeps its place and re-scanning —
  // still one click away — moves in here.
  const backlogOverflowItems: OverflowMenuItem[] = folderPath
    ? [
        {
          id: 'refresh-backlog',
          label: 'Refresh backlog',
          onSelect: () => void runScan(),
          disabled: loading,
          icon: <RefreshIcon />,
        },
      ]
    : []

  const backlogOverflow =
    backlogOverflowItems.length > 0 ? (
      <OverflowMenu ariaLabel="Backlog actions" items={backlogOverflowItems} />
    ) : undefined

  // A bare plus. The word is redundant next to a panel that already says
  // Backlog, and at panel widths it was the thing that squeezed the title into
  // an ellipsis.
  const newPlanButton = (
    <Tooltip content="New item" placement="bottom">
      <IconButton aria-label="New backlog item" onClick={openCreate} disabled={!folderPath}>
        <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
          <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </IconButton>
    </Tooltip>
  )

  const actions: BacklogActions = {
    createFolder: () => void createBacklogFolder(),
    chooseFolder: chooseBacklogFolder,
    useDefaultFolder: () => void applyBacklogRoot(null),
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
    setMockups: (item, mockups) => void setItemMockups(item, mockups),
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

  // The band's count is the visible row count. The two whole-set views — Active
  // (the default working set) and All items (the firehose) — read as "the
  // backlog" and carry no scope word; every narrowing lens (Completed, Archived,
  // the triage presets) labels its scope so a bare number never reads as the
  // whole backlog (T16 AC3).
  const headerScopeLabel =
    view !== 'all' && view !== 'active' ? VIEW_SCOPE_LABEL[view] : search.trim() !== '' ? 'filtered' : undefined

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
      }
    },
    [folderPath, runScan, workspaceId],
  )

  const externalActionsForItem = useCallback(
    (item: BacklogItem, selectionItems?: ReadonlyArray<BacklogItem>) => {
      const base = backlogActionContext(item)
      if (!base) return []
      // The whole-selection context: the menu was opened inside a
      // multi-selection, so module actions read every selected item plus the full
      // scan for epic expansion. Single-item callers pass nothing and the context
      // is byte-identical to before.
      const context = selectionItems ? { ...base, selection: { items: selectionItems, projectItems: items } } : base
      return getRendererHost()
        .getBacklogItemActions()
        .filter((action) => selectModuleEnabled(moduleOverrides, action.moduleId))
        .filter((action) => (action.isVisible ? action.isVisible(context) : true))
        .map((action) => ({
          action,
          label: action.getLabel?.(context) ?? action.label,
          disabled: action.getState?.(context) === 'disabled',
          run: () =>
            runAction(async () => {
              await action.run(context)
            }),
        }))
    },
    [backlogActionContext, items, moduleOverrides, runAction],
  )

  const externalActions = useMemo(
    () => (detailItem ? externalActionsForItem(detailItem) : []),
    [externalActionsForItem, detailItem],
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
  // list face so the menu doesn't open over a swapped-in detail pane. Inside a
  // live multi-selection the menu acts on the whole set; on any unselected row
  // it collapses the selection to that row first (platform convention).
  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent, item: BacklogItem) => {
      event.preventDefault()
      // Even a set of one acts as a selection, so a lone selected epic
      // launches with its bundle; the reduced menu only engages above one row.
      const inSelection = Boolean(multiSelection.keys?.has(item.id))
      setSelectedId(item.id)
      if (!inSelection) setMultiSelection(collapseBacklogSelectionTo(item.id))
      setRowMenu({ itemId: item.id, x: event.clientX, y: event.clientY, selection: inSelection })
    },
    [multiSelection],
  )

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

  const menuItem = rowMenu ? (filtered.find((item) => item.id === rowMenu.itemId) ?? null) : null
  // The rows the open menu acts on, in list order — only when it was opened
  // inside a live multi-selection.
  const menuSelectionItems = useMemo(() => {
    if (!rowMenu?.selection || !menuItem || !multiSelection.keys) return null
    return filtered.filter((item) => multiSelection.keys?.has(item.id))
  }, [rowMenu, menuItem, multiSelection, filtered])
  const menuItemActions = useMemo(
    () =>
      menuItem
        ? externalActionsForItem(menuItem, menuSelectionItems ?? undefined).map(({ action, label, disabled, run }) => ({
            id: action.id,
            label,
            category: action.category,
            order: action.order,
            disabled,
            run,
          }))
        : [],
    [externalActionsForItem, menuItem, menuSelectionItems],
  )

  // A mutation that removes the item from the current view (rename, archive,
  // delete, filter change) closes the menu rather than leaving it aimed at a
  // target that no longer exists.
  useEffect(() => {
    if (rowMenu && !menuItem) setRowMenu(null)
  }, [rowMenu, menuItem])

  // A backlog that is not in the checkout says so, quietly and permanently.
  // Without this the only place the redirect is visible is the missing-folder
  // state, so a working redirect would be invisible and unchangeable — you
  // could point it somewhere and then have no way back but the config file.
  const backlogRootNote =
    backlogLocation && !backlogLocation.isDefault ? (
      <div className="flex items-center gap-2 border-t border-[color:var(--border-subtle)] px-3 py-1.5 text-micro text-[color:var(--text-subtle)]">
        <TruncatedText
          as="span"
          text={`Backlog folder: ${backlogLocation.root}`}
          className="min-w-0 flex-1 font-mono"
        />
        <GhostButton size="sm" onClick={chooseBacklogFolder}>
          Change
        </GhostButton>
        <GhostButton size="sm" onClick={() => void applyBacklogRoot(null)}>
          Use default
        </GhostButton>
      </div>
    ) : null

  const listPane = (
    <BacklogList
      items={filtered}
      groupedRows={groupedRows}
      navIndexById={navIndexById}
      selectedId={selectedId}
      selectedRowIds={selectedRowIds}
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
      epicMetaBySlug={epicMeta}
      epicProgressBySlug={epicProgress}
      dependencyStateById={dependencyStateById}
      epicBlockedBySlug={epicBlockedBySlug}
      onOpenEpic={navigateToEpicBySlug}
    />
  )

  const detailPane = (
    <BacklogDetail
      backlogLocation={backlogLocation}
      scan={scan}
      loading={loading}
      folderPath={folderPath}
      selected={detailItem}
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
      dependencyNode={detailItem ? (dependencyGraph.byItemId.get(detailItem.id) ?? null) : null}
      dependencyState={detailItem ? (dependencyStateById.get(detailItem.id) ?? null) : null}
      dependencyStateById={dependencyStateById}
      epicBlockedRollup={detailItem?.isEpic ? epicBlockedBySlug.get(epicSlug(detailItem)) : undefined}
      dependencyChoices={dependencyChoices}
      onNavigate={navigateToBacklogItem}
      agentTargets={agentTargets}
      agentSessions={agentSessions}
      onAgentFlyoutOpen={refreshAgentSessions}
      onSendToAgent={(item, sessionId) => void sendItemToAgent(item, sessionId)}
      previewedMockup={previewedMockup}
      onOpenMockup={openMockupPreview}
      onCloseMockupPreview={() => setPreviewedMockup(null)}
      onPopOutMockup={() => {
        if (!previewedMockup) return
        const name = basename(previewedMockup.relativePath)
        openFile(workspaceId, previewedMockup.absolutePath, name, previewedMockup.content)
        focusOrAddFileTab(workspaceId, previewedMockup.absolutePath, name)
      }}
    />
  )

  return (
    <section
      ref={rootRef}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-[color:var(--bg-surface)] text-[color:var(--text-default)]"
      aria-label="Backlog"
    >
      {/*
       * The panel's one chrome row: search on the left, the count, the filter
       * glyph and the actions on the right (owner, 2026-09-05).
       *
       * It used to be a PanelHeader reading "Backlog · 297" with the search
       * band on a second row below it. The word was already on screen — the
       * pane tab this panel lives in is labelled "Backlog" — so the identity
       * row was a band of chrome that said nothing the surface did not,
       * stacked above the band that did. Same ruling, same geometry as the Git
       * pane's band, so the three pane tabs start their content level.
       *
       * The count is the visible row count and keeps its scope word: the two
       * whole-set views (Active, All) read as "the backlog" and carry a bare
       * number; every narrowing lens labels its scope so the number never
       * reads as the whole backlog (T16 AC3).
       */}
      <div className="flex h-[36px] shrink-0 items-center gap-1 border-b border-[color:var(--border-default)] pl-2 pr-1.5">
        <div
          className="flex min-w-0 flex-1"
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
        <span className="shrink-0 px-1 text-micro tabular-nums text-[color:var(--text-muted)]">
          {filtered.length}
          {headerScopeLabel ? ` ${headerScopeLabel}` : null}
        </span>
        {newPlanButton}
        {backlogOverflow}
      </div>

      {actionError ? (
        <div className="shrink-0 px-3 py-2">
          <InlineNotice
            tone="error"
            action={
              <GhostButton size="xs" onClick={() => setActionError(null)}>
                Dismiss
              </GhostButton>
            }
          >
            {actionError}
          </InlineNotice>
        </div>
      ) : null}

      {partialErrors ? (
        <div className="shrink-0 px-3 py-2">
          <InlineNotice tone="warn">
            {partialErrors.length} {partialErrors.length === 1 ? 'item' : 'items'} couldn’t be read and{' '}
            {partialErrors.length === 1 ? 'is' : 'are'} not listed
            {': '}
            <span className="font-mono text-meta tabular-nums">
              {partialErrors.map((error) => error.relativePath).join(', ')}
            </span>
          </InlineNotice>
        </div>
      ) : null}

      {duplicateIdWarnings ? (
        <div className="shrink-0 px-3 py-2">
          <InlineNotice tone="warn">
            {duplicateIdWarnings.length === 1 ? 'A duplicate id' : 'Duplicate ids'} from concurrent edits — resolve by
            re-allocating one side:
            {duplicateIdWarnings.map((warning) => (
              <span key={warning.label} className="mt-0.5 block font-mono text-meta tabular-nums">
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
            {backlogRootNote}
          </div>
          <div className="min-h-0 flex-1">{detailPane}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {showDetailInSingle && detailItem ? (
            detailPane
          ) : (
            <>
              {listPane}
              {backlogRootNote}
            </>
          )}
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
          selectionCount={menuSelectionItems?.length}
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
          <div key={index} className="px-3 py-1.5">
            <div className="flex items-center gap-2">
              <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full bg-[color:var(--skeleton-shimmer-high)]" />
              <Skeleton className="h-3 rounded bg-[color:var(--skeleton-shimmer-high)]" style={{ width: row.title }} />
            </div>
            <div className="mt-1 pl-[22px]">
              <Skeleton className="h-2.5 rounded bg-[color:var(--skeleton-shimmer-high)]" style={{ width: row.meta }} />
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
  selectedRowIds,
  onSelect,
  onToggleCollapse,
  onKeyDown,
  onItemDragStart,
  onItemContextMenu,
  skeleton,
  emptyHint,
  now,
  epicMetaBySlug,
  epicProgressBySlug,
  dependencyStateById,
  epicBlockedBySlug,
  onOpenEpic,
}: {
  items: BacklogItem[]
  // Non-null when grouping by epic: the flattened header+child render order.
  // Null keeps the flat list path (byte-identical to the ungrouped default).
  groupedRows: BacklogGroupedRow[] | null
  navIndexById: ReadonlyMap<string, number>
  selectedId: string | null
  // The rows painted selected: the multi set, or the cursor row alone.
  selectedRowIds: ReadonlySet<string>
  onSelect: (id: string, modifiers?: { toggle?: boolean; range?: boolean }) => void
  onToggleCollapse: (group: BacklogEpicGroup) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLUListElement>) => void
  onItemDragStart?: (event: React.DragEvent<HTMLLIElement>, item: BacklogItem) => void
  onItemContextMenu?: (event: React.MouseEvent, item: BacklogItem) => void
  skeleton: boolean
  emptyHint: string | null
  now: number
  // slug -> epic identity, for the row tint + the flat-view member chip.
  epicMetaBySlug: ReadonlyMap<string, BacklogEpicMeta>
  // slug -> true full-scan completion, for epic rows and group headers.
  epicProgressBySlug: ReadonlyMap<string, BacklogEpicProgress>
  // Derived dependency markers per item id (see backlogDependencies): 'blocked'
  // rows present as gated instead of Ready, 'waiting' rows keep their status
  // and gain the softer badge. Absent entry = dependency-free.
  dependencyStateById?: ReadonlyMap<string, BacklogDependencyState>
  // slug -> granular epic blocked rollup, for the "N blocked" count on epic
  // rows and group headers.
  epicBlockedBySlug?: ReadonlyMap<string, BacklogEpicBlockedRollup>
  // Member-row epic-pill jump (flat list only — grouped rows carry no pill).
  onOpenEpic?: (slug: string) => void
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
    return <EmptyState title={emptyHint} className="flex-1" />
  }

  // The option index is the row's position in the flattened nav order; it equals
  // the list index in flat mode, so `backlog-opt-<n>` ids stay byte-identical.
  const activeIndex = selectedId != null ? (navIndexById.get(selectedId) ?? -1) : -1

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label="Backlog items"
      aria-multiselectable
      tabIndex={0}
      onKeyDown={onKeyDown}
      // Active-descendant so screen readers announce the active plan as j/k/arrow
      // navigation moves selection while focus stays on the listbox.
      aria-activedescendant={activeIndex >= 0 ? `backlog-opt-${activeIndex}` : undefined}
      className="min-h-0 flex-1 overflow-y-auto py-1 outline-none focus-visible:focus-ring-inset"
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
                dependencyState={row.group.epic ? dependencyStateById?.get(row.group.epic.id) : undefined}
                blockedRollup={row.group.slug ? epicBlockedBySlug?.get(row.group.slug) : undefined}
              />
            ) : (
              <BacklogOptionRow
                key={row.item.id}
                item={row.item}
                optionIndex={navIndexById.get(row.item.id) ?? -1}
                selected={selectedRowIds.has(row.item.id)}
                indented
                onSelect={onSelect}
                onItemDragStart={onItemDragStart}
                onItemContextMenu={onItemContextMenu}
                now={now}
                epicMeta={row.item.epic ? epicMetaBySlug.get(row.item.epic) : undefined}
                dependencyState={dependencyStateById?.get(row.item.id) ?? null}
              />
            ),
          )
        : items.map((item) => (
            <BacklogOptionRow
              key={item.id}
              item={item}
              optionIndex={navIndexById.get(item.id) ?? -1}
              selected={selectedRowIds.has(item.id)}
              onSelect={onSelect}
              onItemDragStart={onItemDragStart}
              onItemContextMenu={onItemContextMenu}
              now={now}
              // A member row resolves its PARENT epic's identity; an epic row
              // resolves its OWN, so the banner treatment (tinted glyph, meter
              // colour, full-row wash) rides the same prop.
              epicMeta={
                item.epic ? epicMetaBySlug.get(item.epic) : item.isEpic ? epicMetaBySlug.get(epicSlug(item)) : undefined
              }
              epicProgress={item.isEpic ? epicProgressBySlug.get(epicSlug(item)) : undefined}
              dependencyState={dependencyStateById?.get(item.id) ?? null}
              epicBlocked={item.isEpic ? epicBlockedBySlug?.get(epicSlug(item)) : undefined}
              onOpenEpic={onOpenEpic}
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
  epicMeta,
  epicProgress,
  dependencyState,
  epicBlocked,
  onOpenEpic,
}: {
  item: BacklogItem
  optionIndex: number
  selected: boolean
  indented?: boolean
  onSelect: (id: string, modifiers?: { toggle?: boolean; range?: boolean }) => void
  onItemDragStart?: (event: React.DragEvent<HTMLLIElement>, item: BacklogItem) => void
  onItemContextMenu?: (event: React.MouseEvent, item: BacklogItem) => void
  now: number
  // The row's epic identity: a member's parent epic, or an epic row's own.
  // Drives the option-C full-row tint and, in the flat (ungrouped) list, the
  // member's epic chip / the epic's banner treatment.
  epicMeta?: BacklogEpicMeta
  // An epic row's true completion rollup (full scan), for the progress meter.
  epicProgress?: BacklogEpicProgress
  // Derived dependency marker ('blocked' presents in place of Ready; 'waiting'
  // is the softer badge) and, for an epic row, the granular blocked count.
  dependencyState?: BacklogDependencyState | null
  epicBlocked?: BacklogEpicBlockedRollup
  // Cross-navigation for the member row's epic pill: clicking it opens the
  // epic (the widening navigate), the inverse of the detail crumb.
  onOpenEpic?: (slug: string) => void
}): JSX.Element {
  const archived = item.status === 'archived'
  // Option C: the epic identity colour fills the whole member row (below a
  // hand-set highlight, above the ambient risk heat — see resolveBacklogRowColor)
  // on every row the user has not picked. Selection outranks it — backlogRowPaint.
  // No left bar (ruled 2026-09-02): the row reserves no `border-l-[3px]`, so the
  // helper's bar colour has no width to paint; `EpicColorDot` carries the epic.
  const { color: stripeColor, litFill } = resolveBacklogRowColor(item, epicMeta?.color ?? null)
  return (
    <li
      id={`backlog-opt-${optionIndex}`}
      role="option"
      aria-selected={selected}
      draggable={Boolean(onItemDragStart)}
      onDragStart={onItemDragStart ? (event) => onItemDragStart(event, item) : undefined}
      onContextMenu={onItemContextMenu ? (event) => onItemContextMenu(event, item) : undefined}
      onClick={(event) => onSelect(item.id, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey })}
      // A shift-click is a selection gesture, not a text-selection start.
      onMouseDown={(event) => {
        if (event.shiftKey) event.preventDefault()
      }}
      className={`cursor-pointer ${indented ? 'pl-6 pr-3' : 'px-3'} py-1.5 transition-colors ${backlogRowPaintClass({
        color: stripeColor,
        litFill,
        selected,
      })} ${archived ? 'opacity-70' : ''}`}
    >
      {/* The whole row carries one styled hover card (full title, status, id,
          path) in place of the old native `title` path tooltip. A calm 600ms
          delay so it never flickers while scanning the list; `plainTitle`
          keeps the clipped-title tooltip from stacking a second popover. The
          wrapper is presentational so the listbox's option semantics hold. */}
      <Tooltip
        content={<BacklogRowHoverCard item={item} epicProgress={epicProgress} dependencyState={dependencyState} />}
        placement="top"
        openDelayMs={600}
        wrapperClassName="block"
        wrapperRole="presentation"
      >
        <div>
          <BacklogRowContent
            item={item}
            now={now}
            dependencyState={dependencyState}
            epicBlocked={epicBlocked}
            epicMeta={indented ? undefined : epicMeta}
            epicProgress={epicProgress}
            plainTitle
            selected={selected}
            onOpenEpic={onOpenEpic && item.epic && !item.isEpic ? () => onOpenEpic(item.epic as string) : undefined}
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
// item, so the whole row toggles collapse. The epic's `color:` frontmatter
// tints the row through `backlogRowPaintClass`; there is no left bar (ruled
// 2026-09-02).
function BacklogGroupHeaderRow({
  row,
  optionIndex,
  selected,
  onSelect,
  onToggleCollapse,
  onItemDragStart,
  onItemContextMenu,
  progress,
  dependencyState,
  blockedRollup,
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
  // The epic's derived dependency marker + granular blocked-children rollup,
  // mirrored from the flat epic row so the two presentations can't drift.
  dependencyState?: BacklogDependencyState | null
  blockedRollup?: BacklogEpicBlockedRollup
}): JSX.Element {
  const { group } = row
  const epic = group.kind === 'epic' ? group.epic : null
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
      className={`cursor-pointer px-3 py-1.5 transition-colors ${backlogRowPaintClass({
        color: group.color,
        litFill: false,
        selected,
      })}`}
    >
      {/* The epic's path rides the product tooltip (same shape as the item row's
          hover card), not a native `title`; a plain group header's title is
          already the visible label, so it gets no tooltip at all. */}
      {epic ? (
        <Tooltip
          content={epic.relativePath}
          placement="top"
          openDelayMs={600}
          wrapperClassName="block"
          wrapperRole="presentation"
        >
          <div>
            <BacklogEpicHeaderContent
              group={group}
              collapsed={row.collapsed}
              selected={selected}
              onToggleCollapse={() => onToggleCollapse(group)}
              progress={progress}
              dependencyState={dependencyState}
              blockedRollup={blockedRollup}
            />
          </div>
        </Tooltip>
      ) : (
        <BacklogEpicHeaderContent
          group={group}
          collapsed={row.collapsed}
          selected={selected}
          onToggleCollapse={() => onToggleCollapse(group)}
          progress={progress}
          dependencyState={dependencyState}
          blockedRollup={blockedRollup}
        />
      )}
    </li>
  )
}

// ---- Detail / preview ------------------------------------------------------

// Exported for the Backlog door: the door renders THIS component for
// an opened item — one detail implementation, so the aside and the door can
// never drift. The door supplies its per-project feed data and degrades the
// workspace-only inputs (agent targets, external actions) explicitly.
export function BacklogDetail({
  scan,
  loading,
  folderPath,
  selected,
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
  dependencyState,
  dependencyStateById,
  epicBlockedRollup,
  dependencyChoices,
  onNavigate,
  agentTargets,
  agentSessions,
  onAgentFlyoutOpen,
  onSendToAgent,
  previewedMockup,
  onOpenMockup,
  onCloseMockupPreview,
  onPopOutMockup,
  backlogLocation = null,
}: {
  scan: BacklogScanResult | null
  loading: boolean
  folderPath: string | null
  selected: BacklogItem | null
  now: number
  hasItems: boolean
  externalActions: Array<{ action: BacklogItemAction; label: string; disabled: boolean; run: () => void }>
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
  // The selected item's derived dependency marker: 'blocked' overrides the
  // header's status glyph and word, exactly as on its list row.
  dependencyState?: BacklogDependencyState | null
  // Markers for every item, so an epic's children roll-up shows each member's
  // blocked state the same way the list does.
  dependencyStateById?: ReadonlyMap<string, BacklogDependencyState>
  // A selected epic's granular blocked rollup for the roll-up readout.
  epicBlockedRollup?: BacklogEpicBlockedRollup
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
  // Inline mockup preview: the currently-open mockup (rendered in
  // place of the item content), the open handler the Mockups section calls, and
  // the back/close clear. Owned by the panel so it survives this component's
  // early returns and clears on selection change.
  previewedMockup: { path: string; absolutePath: string; relativePath: string; content: string } | null
  onOpenMockup: (target: { path: string; relativePath: string; absolutePath: string }) => void
  onCloseMockupPreview: () => void
  // Pop the previewed mockup out into a source editor tab (the FilePreviewPane
  // "Open in editor" jump-out), wired to the workspace openFile bridge.
  onPopOutMockup: () => void
  /**
   * Where this workspace's backlog lives, for the missing-folder state. Null
   * while it is still being resolved, which reads as the default — the right
   * guess for every workspace that has not configured a root.
   */
  backlogLocation?: BacklogLocationInfo | null
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
    // A configured folder that is not there is a different problem from never
    // having had one — an unplugged drive, a backlog repo not cloned on this
    // machine — and the fix is different too. Saying "no backlog folder yet"
    // over a folder someone chose reads as lost work.
    const redirected = backlogLocation !== null && !backlogLocation.isDefault
    return (
      <DetailState
        heading={redirected ? 'Backlog folder not found' : 'No backlog folder'}
        body={
          redirected
            ? `This workspace's backlog is set to ${backlogLocation.root}, which isn't there right now. Nothing has been lost — reconnect the folder, pick a different one, or go back to the default.`
            : 'This workspace has no backlog folder yet. Create one to start capturing items, or point it at a folder you already keep them in.'
        }
        cta={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {redirected ? null : <PrimaryButton onClick={actions.createFolder}>Create backlog folder</PrimaryButton>}
            {actions.chooseFolder ? (
              <GhostButton onClick={actions.chooseFolder}>
                {redirected ? 'Choose a different folder' : 'Choose a folder…'}
              </GhostButton>
            ) : null}
            {redirected && actions.useDefaultFolder ? (
              <GhostButton onClick={actions.useDefaultFolder}>Use the default</GhostButton>
            ) : null}
          </div>
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
              <li key={error.relativePath} className="font-mono text-meta tabular-nums">
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

  // Inline mockup preview: while a mockup is open it replaces the
  // item content — shared FilePreviewPane chrome (back / pop-out / close) with the sandboxed
  // HtmlArtifactFrame as the body override for HTML, and the pane's own
  // extension-based markdown/plain-text rendering for anything else. Back and
  // close both return to the item; pop-out opens the source in an editor tab.
  if (previewedMockup) {
    const isHtmlPreview = /\.html?$/i.test(previewedMockup.relativePath)
    return (
      <FilePreviewPane
        title={basename(previewedMockup.relativePath)}
        path={previewedMockup.absolutePath}
        content={previewedMockup.content}
        onBack={onCloseMockupPreview}
        onClose={onCloseMockupPreview}
        onPopOut={onPopOutMockup}
        body={
          isHtmlPreview ? (
            <HtmlArtifactFrame
              absolutePath={previewedMockup.absolutePath}
              relativePath={previewedMockup.relativePath}
              watchDirectoryPath={parentPath(previewedMockup.absolutePath)}
              enableSourceView
            />
          ) : undefined
        }
      />
    )
  }

  // Epic ⇄ child traversal, both derived from the live scan (never stored):
  //  - parentEpic: a child's epic, resolved to its concept item so the crumb can
  //    navigate up (null for epics and for orphan/dangling-slug items);
  //  - epicChildren: an epic's members, for the roll-up that navigates down;
  //  - currentEpicColor: the epic's `color:` for the picker's selected swatch.
  // The derived-blocked presentation: like the list row, a blocked marker
  // replaces the Ready glyph and word.
  const selectedBlocked = dependencyState === 'blocked'
  const isEpic = selected.isEpic
  const parentEpic =
    !isEpic && selected.epic
      ? (items.find((candidate) => candidate.isEpic && epicSlug(candidate) === selected.epic) ?? null)
      : null
  const parentEpicColor = parentEpic && selected.epic ? (epicMetaBySlug.get(selected.epic)?.color ?? null) : null
  const epicChildren = isEpic ? childrenOfEpic(items, epicSlug(selected)) : []
  const currentEpicColor = isEpic ? (epicMetaBySlug.get(epicSlug(selected))?.color ?? null) : null
  // Whether this item can be handed to a fresh agent from the action band. The
  // predicate is shared with the button itself, so the band's layout decision
  // and the control's own gate can never disagree about an item.
  const canHandToAgent = canHandBacklogItemToAgent(selected)
  const showOpenAgent = selected.status !== 'archived' && hasAgentLink(selected)

  // Full timestamp for the relative-time tooltip ("2h ago" → the actual date).
  const modifiedAbsolute =
    typeof selected.modifiedAt === 'number' && Number.isFinite(selected.modifiedAt)
      ? new Date(selected.modifiedAt).toLocaleString()
      : 'Unknown time'

  return (
    // min-w-0: this pane is a flex item on every surface that mounts it, and
    // without it the header row and the markdown body hold their min-content
    // width instead of shrinking — at 1024px the right edge is clipped away
    // with no scrollbar to say so.
    // `data-backlog-detail` is the rendered-pass handle for this pane, the same
    // kind of hook as `[data-context-rail]`. Three surfaces mount this one
    // component and only one of them wraps it in a labelled landmark, so a pass
    // that measures the pane's own anatomy needs a selector that
    // resolves on all three.
    <div data-backlog-detail className="flex h-full min-h-0 min-w-0 flex-col">
      {/* `px-3 py-2` — `ui/PanelHeader`'s inset, so this pane starts where every
          other header does; it sat at `px-4 py-3` (2112).

          NOT the primitive itself: this header wraps its title to two lines,
          which the one-line primitive does not. The inset is what makes the heights agree, and
          that is what converges here.

          ONE identity row. The crumb once had a band of its own so
          the title could own a full line; the overflow menu then took a third
          band whenever the item had no external action to sit beside. On a door
          — where the app's top strip is ALREADY the surface bar above this pane
          — that stacked three chrome rows before any content. The crumb is
          metadata, so it rides the title's own line, right-aligned, with the
          menu it belongs to; the title still wraps to two lines because it is
          `flex-1` beside them, not because it has a band to itself. */}
      {/* No hairline under the header either. Inside this pane the
          only rules are its own edges and the list-side chrome row; the header
          separates from the body on padding, like every section below it. */}
      <header className="shrink-0 px-3 py-2">
        <div className="flex min-w-0 items-start gap-2">
          {showBack ? (
            <IconButton onClick={onBack} aria-label="Back to list" className="-ml-1.5 -mt-0.5 shrink-0">
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                <path
                  d="M10 4L6 8l4 4"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </IconButton>
          ) : null}
          <Tooltip
            content={selectedBlocked ? BACKLOG_BLOCKED_LABEL : BACKLOG_STATUS_LABEL[selected.status]}
            placement="top"
            // `mt-0.5` optically centres the 16px glyph on the FIRST line of a
            // title that may wrap to two — `items-start` alone hangs it high.
            wrapperClassName="mt-0.5 inline-flex shrink-0"
          >
            <LifecycleGlyph
              state={selectedBlocked ? 'blocked' : backlogStatusToLifecycle(selected.status)}
              // The glyph NAMES the state now that the word beside it is gone.
              // A tooltip only reaches a pointer — dropping the word
              // without this left the status readable by shape alone.
              label={selectedBlocked ? BACKLOG_BLOCKED_LABEL : BACKLOG_STATUS_LABEL[selected.status]}
              // A bare in_progress status has no agent working it, so the arc
              // stays static.
              live={false}
            />
          </Tooltip>
          {/* The title is the header's one clear priority: it takes the whole of
              the row that is left and still wraps to two lines, revealing the
              full text in a tooltip when clamped. Its minted id leads it — the
              id IS the item's name in every conversation about it, so it reads
              with the title, not as metadata exiled to the far corner. */}
          {selected.displayId ? (
            <span className="mt-1 shrink-0 font-mono text-micro tabular-nums text-[color:var(--text-subtle)]">
              {selected.displayId}
            </span>
          ) : null}
          <TruncatedText
            as="h3"
            multiline
            text={selected.title}
            placement="bottom"
            className="min-w-0 flex-1 line-clamp-2 text-heading font-semibold leading-snug text-[color:var(--text-strong)]"
          />
          {/* Time + the menu that acts on this item, right-aligned on the
              title's own line. The id moved to lead the title; an item the scan
              never minted one for (allocation is best-effort) keeps its file
              name here, so the cluster never says only "4m ago".

              The status WORD stays gone: the glyph at the head of the
              row already says the state and carries it as an accessible name. The
              path stays out too — long, truncated, and not identity; it is
              readable from this menu ("Copy path") and from Reveal in Files. */}
          <div className="mt-0.5 flex shrink-0 items-center gap-1.5 text-micro text-[color:var(--text-muted)]">
            {selected.displayId ? null : (
              <>
                <span className="whitespace-nowrap font-mono tabular-nums text-[color:var(--text-subtle)]">
                  {basename(selected.relativePath)}
                </span>
                <span aria-hidden="true" className="text-[color:var(--text-disabled)]">
                  ·
                </span>
              </>
            )}
            <Tooltip content={modifiedAbsolute} placement="top" wrapperClassName="inline-flex">
              <span className="whitespace-nowrap tabular-nums">
                {formatRelativeMsAgo(selected.modifiedAt, now) || 'unknown'}
              </span>
            </Tooltip>
            <OverflowMenu
              ariaLabel="More actions"
              triggerTooltip="More actions"
              items={[
                ...overflowItemsForBacklogModuleActions(
                  externalActions.map(({ action, label, disabled, run }) => ({
                    id: action.id,
                    label,
                    category: action.category,
                    order: action.order,
                    disabled,
                    run,
                  })),
                ),
                // The file-navigation actions were on their own buttons; folded in
                // here they free the row down to the primary action + this menu.
                { id: 'open-in-editor', label: 'Open in editor', onSelect: () => actions.openInEditor(selected) },
                { id: 'reveal-in-files', label: 'Reveal in Files', onSelect: () => actions.revealInFiles(selected) },
                // Where the path went when it left the crumb. Through
                // the app's own clipboard bridge: an Electron renderer has no
                // permission-free `navigator.clipboard`, so that path was a
                // silent no-op. The ABSOLUTE path, matching the two rows above it
                // — a relative path is ambiguous across projects on a door.
                {
                  id: 'copy-path',
                  label: 'Copy path',
                  onSelect: () => {
                    void window.api?.clipboardWriteText?.(selected.path)
                  },
                },
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
                  ? [
                      {
                        id: 'mark-completed',
                        label: 'Mark completed',
                        onSelect: () => actions.setStatus(selected, 'completed'),
                      },
                    ]
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
        </div>
        {/* Child → epic link: a plain link up to the parent epic (no back arrow —
            it navigates sideways to a sibling concept, not "back"). Carries the
            epic's identity colour, and its full name in a tooltip when clipped. */}
        {parentEpic ? (
          <GhostButton
            size="inline"
            align="start"
            onClick={() => onNavigate(parentEpic.id)}
            aria-label={`Open epic ${parentEpic.title}`}
            className="mt-1.5 -ml-1 min-h-6 max-w-full"
          >
            <EpicColorDot color={parentEpicColor} size={7} />
            <TruncatedText as="span" text={parentEpic.title} className="min-w-0" />
          </GhostButton>
        ) : null}

        {/* Earned, not standing: a host with no shell action to offer
            gets no action band at all, because the overflow menu that used to be
            stranded on it now sits inline with the title it acts on.
            "Hand to agent" is the header's primary button; "Open agent" sits
            beside it when the item already has an agent link. Module actions
            live in the menus, not here (owner ruling 2026-09-15). */}
        {canHandToAgent || showOpenAgent ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {canHandToAgent ? <BacklogHandToAgentButton item={selected} workspaceRoot={folderPath} /> : null}
            {showOpenAgent ? (
              <BacklogOpenAgentButton item={selected} workspaceId={workspaceId} workspaceRoot={folderPath} />
            ) : null}
          </div>
        ) : null}
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
            dependencyStateById={dependencyStateById}
            blockedRollup={epicBlockedRollup}
            onNavigate={onNavigate}
          />
        ) : null}

        {/* Mockups lead the metadata sections (above Links): design mockups
            attach to epics and leaf items alike (amendment 3). A `type: mockup`
            item is exempt — it IS the mockup, rendered directly below. */}
        {selected.type !== 'mockup' ? (
          <BacklogMockupsSection
            item={selected}
            folderPath={folderPath}
            onOpenMockup={onOpenMockup}
            onSetMockups={actions.setMockups}
          />
        ) : null}

        <BacklogLinksSection
          item={selected}
          workspaceId={workspaceId}
          workspaceRoot={folderPath}
          providers={linkProviders}
          epicChildStatuses={isEpic ? epicChildren.map((child) => child.status) : undefined}
          onRemoveLink={(link) => actions.removeLink(selected, link)}
        />

        <BacklogTriage item={selected} actions={actions} epicChoices={epicChoices} />

        {!selected.isEpic ? (
          <BacklogDependenciesSection
            item={selected}
            node={dependencyNode}
            dependencyChoices={dependencyChoices}
            dependencyStateById={dependencyStateById}
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

function DetailState({ heading, body, cta }: { heading?: string; body: string; cta?: React.ReactNode }): JSX.Element {
  return <EmptyState title={heading ?? body} body={heading ? body : undefined} action={cta} />
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
  dependencyStateById,
  blockedRollup,
  onNavigate,
}: {
  members: BacklogItem[]
  color: BacklogHighlightColor | null
  // Derived dependency markers per item, so a blocked member reads Blocked here
  // exactly as it does in the list.
  dependencyStateById?: ReadonlyMap<string, BacklogDependencyState>
  // The epic's granular blocked rollup for the "N blocked" readout beside the
  // done fraction.
  blockedRollup?: BacklogEpicBlockedRollup
  onNavigate: (id: string) => void
}): JSX.Element {
  const total = members.length
  const done = members.reduce((count, child) => (child.status === 'completed' ? count + 1 : count), 0)
  return (
    <Section
      title="Children"
      level={4}
      inset
      // The count, the `N of M done` sentence and a bar of its own said one
      // thing three ways and cost three stacked rows before the first child.
      // `EpicProgressMeter` is the shipped primitive that renders
      // done/total BESIDE its bar in one line — the same readout the epic row
      // and the grouped epic header already use — so the heading row carries
      // the whole roll-up and the members follow it directly.
      action={
        total > 0 ? (
          <span className="flex items-baseline gap-2">
            {blockedRollup && blockedRollup.blocked > 0 ? (
              <span className="whitespace-nowrap text-micro tabular-nums text-[color:var(--text-muted)]">
                {blockedRollup.blocked} of {blockedRollup.remaining} remaining blocked
              </span>
            ) : null}
            <EpicProgressMeter progress={{ done, total }} color={color} />
          </span>
        ) : undefined
      }
      // No hairline: padding and the heading separate this section from the next
      // ("space groups, rules do not").
      className="shrink-0 pb-3"
    >
      {/* An epic with no members is its heading and nothing else. The sentence
          that used to sit here explained a control on ANOTHER surface — the row
          menu — which is copy the pane must not carry. */}
      {total === 0 ? null : (
        <div className="px-3">
          <ul className="flex flex-col">
            {members.map((child) => {
              // A derived-blocked member reads Blocked here, matching its list
              // row.
              const childBlocked = dependencyStateById?.get(child.id) === 'blocked'
              return (
                <li key={child.id}>
                  {/* The member's path rides the product tooltip on the row button
                    (its own focusable trigger), not a native `title`. */}
                  <Tooltip content={child.relativePath} placement="top" openDelayMs={600} wrapperClassName="block">
                    <RowButton onClick={() => onNavigate(child.id)}>
                      <Tooltip
                        content={childBlocked ? BACKLOG_BLOCKED_LABEL : BACKLOG_STATUS_LABEL[child.status]}
                        placement="top"
                      >
                        <LifecycleGlyph
                          state={childBlocked ? 'blocked' : backlogStatusToLifecycle(child.status)}
                          // A bare in_progress status renders the static quarter
                          // arc: the item file is a record, not a live signal.
                          live={false}
                        />
                      </Tooltip>
                      {child.displayId ? (
                        <span className="shrink-0 font-mono text-micro tabular-nums text-[color:var(--text-subtle)]">
                          {child.displayId}
                        </span>
                      ) : null}
                      <TruncatedText
                        as="span"
                        text={child.title}
                        className={`min-w-0 flex-1 text-meta ${
                          child.status === 'completed'
                            ? 'text-[color:var(--text-muted)]'
                            : 'text-[color:var(--text-default)]'
                        }`}
                      />
                      <DifficultyIndicator difficulty={child.difficulty} />
                      <CriticalityIndicator criticality={child.criticality} />
                    </RowButton>
                  </Tooltip>
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
    // No hairline, and no label column: the section heading already
    // says "Epic", so a second "Epic" beside the one control it holds restated
    // the heading in a 3.5rem gutter. The control is now the section's body.
    <Section title="Epic" level={4} inset className="shrink-0 pb-3">
      <div className="max-w-[16rem] px-3">
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
        <TriggerButton
          ref={ref}
          open={triggerProps['aria-expanded'] === true}
          aria-haspopup="dialog"
          aria-expanded={triggerProps['aria-expanded']}
          aria-controls={triggerProps['aria-controls']}
          aria-label="Move to epic"
          onClick={togglePopover}
          className="min-w-[140px]"
        >
          <span className="min-w-0 flex-1 truncate">{currentLabel}</span>
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
            className="shrink-0 text-[color:var(--text-muted)]"
          >
            <path
              d="M2 4l3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.4"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </TriggerButton>
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
        {/* `RowButton`, not `MenuOption`: these two commit an ACTION rather than
            a value, so neither of the option roles is honest, and the popover is
            a dialog the keyboard tabs into rather than a menu with roving focus —
            which is the tab stop `MenuItem` would take away. */}
        <RowButton
          onClick={() => {
            setOpen(false)
            actions.createEpic(item)
          }}
          className="text-meta"
        >
          New epic…
        </RowButton>
        {item.epic ? (
          <RowButton
            onClick={() => {
              setOpen(false)
              actions.setEpic(item, null)
            }}
            className="text-meta"
          >
            Remove from epic
          </RowButton>
        ) : null}
      </div>
    </Popover>
  )
}

function BacklogPreviewBody({ item }: { item: BacklogItem }): JSX.Element {
  const isHtml = /\.html?$/i.test(item.relativePath)
  const isMarkdown = !isHtml && /\.md$/i.test(item.relativePath)
  const renderAsMarkdown = isMarkdown && item.sourceContent.length <= MARKDOWN_PREVIEW_MAX_CHARS

  if (renderAsMarkdown) {
    // Strip frontmatter + the leading title H1 so the body doesn't restate the
    // header title at display size or render raw YAML (parity with the row's
    // title-stripped excerpt).
    const body = backlogPreviewMarkdown(item.sourceContent)
    if (!body) {
      return <p className="text-meta text-[color:var(--text-muted)]">No description beyond the title yet.</p>
    }
    // `compact` is the dense-surface ramp (the skill reader's), not the document
    // one: at `document` the body's own h2 renders at 24px inside a pane whose
    // title is 14px and whose section titles are 12px, making the item's prose
    // the largest type on screen.
    //
    // Compact still tops out at `text-title` (16px) for h1, which outranks this
    // pane's 14px title, so h1 is capped here to the pane's own title size. The
    // cap is a descendant selector, so it outweighs the ramp's own `text-title`
    // whatever the class order. h1 and h2 stay a step apart — 14px vs 13px plus
    // the ramp's own spacing — so the ladder survives the cap.
    return <div className="markdown-body [&_h1]:text-heading">{renderMarkdown(body, { density: 'compact' })}</div>
  }
  if (isHtml) {
    // Mockups render through the shared sandboxed frame (scripts off by default,
    // never same-origin — the same seam as the Design preview),
    // so arbitrary HTML still never touches the renderer document (design §5 /
    // renderer-safety rule). Source stays reachable via the frame's toggle.
    return (
      <div className="flex h-[65vh] min-h-[320px] flex-col">
        <HtmlArtifactFrame
          absolutePath={item.path}
          relativePath={item.relativePath}
          watchDirectoryPath={parentPath(item.path)}
          enableSourceView
        />
      </div>
    )
  }
  // Oversized markdown renders as preformatted source.
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-body leading-5 text-[color:var(--text-default)]">
      {item.sourceContent}
    </pre>
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

function planSlug(value: string): string {
  return slugify(value).slice(0, 60) || 'untitled'
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
// shared ../backlog/BacklogRow module so every surface that lists items renders
// the same row and they can't drift.
