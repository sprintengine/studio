import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  NewChatIcon,
  SprintEngineMarkIcon,
  resolveEnabledWorkspaceType,
} from '../AppIcons'
import { buildModeModels } from './newWorkspace/modeModels'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import { FOCUS_RING_CLASS } from '../ui/tokens'
import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  resolveSidebarResize,
} from './sidebarWidth'
import type { ModuleEnablementOverrides } from '../../../../shared/modules/manifest'
import {
  ContextMenu,
  Field,
  Input,
  LifecycleGlyph,
  MenuDivider,
  AgentWorkingDots,
  MenuItem,
  MenuSwatchRow,
  PointerPopover,
  StarGlyph,
  StatusDot,
  Tooltip,
  TruncatedText,
  type Tone,
} from '../ui'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import SidebarAccountBar from './SidebarAccountBar'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  type HighlightColor,
  type LayoutTemplate,
  type Workspace,
  type WorkspaceId,
} from '../../types/workspace'
import { getHighlightSwatch, hasHighlightOverride, isStarred } from '../../utils/highlight'
import {
  addTabAsNewColumn,
  appendTabAsNewColumnInJson,
  buildSingleTabLayoutModel,
  extractTabSpec,
  getModel,
  removeTab,
  type CrossWorkspaceTabSpec,
} from '../../utils/modelRegistry'
import {
  dataTransferHasTabDrag,
  readTabDragPayload,
  type TabDragPayload,
} from '../../utils/tabDragPayload'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { formatRelativeMs, formatRelativeMsAgo } from '../../utils/relativeTime'
import { deriveWorkspaceRunGlyph } from '../../utils/workspaceRunGlyph'
import { isCanceledSprintEngineRun, isCompletedSprintEngineRun } from '../../utils/sprintengine'
import { refreshSprintEngineWorkspaceProjection } from '../../utils/sprintengineProjectionRefresh'
import { publishDiagnostic } from '../../utils/diagnostics'
import { partitionWorkspacesByRecency, sortWorkspacesByActivity } from '../../utils/workspaceRecency'
import { isArchivedWorkspace, isHiddenFromRail } from '../../utils/workspaceVisibility'

type Activity = 'working' | 'failed' | 'needs-input' | 'idle'

type TerminalRecency = { hasRunning: boolean; idleSince: number | null; lastInputAt: number | null }

type WorkspaceDetachPlacement = {
  screenX: number
  screenY: number
}

type WorkspaceSidebarProps = {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  workspaceWindowId: string
  isDetachedWindow: boolean
  sidebarCollapsed: boolean
  // The sidebar's own top strip (SidebarChrome) — window controls that run to the
  // top of the full-height sidebar. Rendered as the first child inside the aside
  // so it shares the column's exact width and resize behavior.
  chromeSlot?: React.ReactNode
  // The drilled-in surface's rail (item 1993). When a door or another drilled-in
  // surface is open its rail REPLACES this column's own content — one rail, ever,
  // never a second navigation column beside the first. The chrome strip above
  // does not participate in the swap. The workspaces rail stays mounted and
  // hidden underneath, so the row that opened the door is still there to take
  // focus back and the tree's scroll offset survives the round trip.
  contextRail?: React.ReactNode
  // Whether that rail is actually occupying the column. A surface with no rail
  // of its own nests nothing, so it replaces nothing and this stays false — the
  // node above is still mounted (it is the portal target that asks the
  // question), it is simply out of the layout.
  contextRailActive?: boolean
  activityByWorkspaceId: Record<WorkspaceId, Activity>
  // Workspaces whose agents are resident (live PTY) right now — bolded as "hot"
  // (instant switch) versus suspended/exited rows that re-launch on open.
  residentWorkspaceIds: Set<WorkspaceId>
  terminalRecencyByWorkspaceId: Record<WorkspaceId, TerminalRecency>
  onSelectWorkspace: (id: WorkspaceId) => void
  onMoveWorkspaceToNewWindow: (id: WorkspaceId, placement?: WorkspaceDetachPlacement) => void
  onMoveWorkspaceToMainWindow: (id: WorkspaceId) => void
  onCloseWorkspace: (id: WorkspaceId) => void
  onDeleteWorkspaceWithState: (id: WorkspaceId) => Promise<void> | void
  onForgetFolder: (folderPath: string) => void
  onNewWorkspace: () => void
  onNewWorkspaceInFolder: (folderPath: string) => void
  // Open the pre-creation New Chat panel scoped to the active workspace's
  // folder — the split create control's primary click.
  onNewChat: () => void
  // Open the creation hub preselected on a type (the "+" menu rows).
  onNewWorkspaceMode: (mode: Workspace['mode']) => void
  // Scope a new chat to a specific project folder (workspace-row context menu).
  // The panel owns the agent/engine choice — the sidebar only opens it.
  onNewChatInFolder: (folderPath: string) => void
  onRevealFolder: (folderPath: string) => void
  onSetSidebarCollapsed: (collapsed: boolean) => void
  // Persisted expanded width (px) and its setter, for drag-to-resize.
  sidebarWidth: number
  onSetSidebarWidth: (width: number) => void
  // Account + Settings cluster, relocated from WorkspaceTopBar to the sidebar
  // bottom (Cursor-parity layout). The handlers stay owned by WorkspaceManager;
  // the sidebar only mounts the controls at their new home.
  authState: MulticodeAuthState
  authMessage: string | null
  accountOpen: boolean
  setAccountOpen: React.Dispatch<React.SetStateAction<boolean>>
  startLogin: () => void | Promise<void>
  refreshAuthState: () => void | Promise<void>
  logout: () => void | Promise<void>
  openSettings: (checkForUpdates?: boolean, targetTab?: string | null) => void
  settingsOpen: boolean
}

type FolderGroup = {
  key: string
  displayName: string
  fullPath: string | null
  missing: boolean
  workspaces: Workspace[]
}

const NULL_FOLDER_KEY = '__no_folder__'

// Folded (older/history) rows reveal in pages of this size — pressing the
// "Show N older" row repeatedly pages through the remainder.
const FOLD_PAGE_SIZE = 5

const DRAG_MIME_WORKSPACE = 'application/x-multicode-workspace'
const DRAG_MIME_FOLDER = 'application/x-multicode-folder'

function normalizeFolder(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '')
}

function folderKey(value: string | null): string {
  if (!value) return NULL_FOLDER_KEY
  return normalizeFolder(value).toLowerCase()
}

function folderDisplayName(value: string | null): string {
  if (!value) return 'No folder'
  const normalized = normalizeFolder(value)
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return normalized
  return normalized.slice(lastSlash + 1) || normalized
}

function buildFolderGroups(workspaces: Workspace[]): FolderGroup[] {
  const groupOrder: string[] = []
  const groups = new Map<string, FolderGroup>()

  for (const workspace of workspaces) {
    const key = folderKey(workspace.folderPath)
    if (!groups.has(key)) {
      groupOrder.push(key)
      groups.set(key, {
        key,
        displayName: folderDisplayName(workspace.folderPath),
        fullPath: workspace.folderPath,
        missing: workspace.folderMissing === true,
        workspaces: [],
      })
    }
    const group = groups.get(key)!
    group.workspaces.push(workspace)
    if (workspace.folderMissing) group.missing = true
  }

  return groupOrder.map((key) => groups.get(key)!)
}

type RowAccent = {
  bg: string
  text: string
  shadow: string
  glyph: string
}

// Mode identity reads through the canonical tool tokens on the icon glyph
// alone. The active row body sits on the brighter `--bg-selected` surface —
// the same canonical selection fill used elsewhere (notifications,
// file/artifact selection) — so the selected row clears the hover
// `--bg-surface-raised` fill by a full step.
//
// The colored 4px left rail is gone: selection is a neutral fill and carries no
// left bar (`design-system/patterns/selection.html`). A collapsed icon rail is
// the one place the design system still permits a stripe — rows there are too
// narrow for a fill to read — but this sidebar has no such rail to except:
// collapsing hides the whole aside rather than narrowing it to icons (the
// `hidden` class on the <aside> below), so no stripe survives here.
const modeAccents: Record<Workspace['mode'], RowAccent> = {
  sprintengine: {
    bg: 'bg-[color:var(--bg-selected)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    glyph: 'text-[color:var(--tool-sprintengine)]',
  },
  switchboard: {
    bg: 'bg-[color:var(--bg-selected)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    glyph: 'text-[color:var(--tool-switchboard)]',
  },
  'guided-brief': {
    bg: 'bg-[color:var(--bg-selected)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    glyph: 'text-[color:var(--accent-primary)]',
  },
  // Automations host carries the same primary-accent identity as its registered
  // accentToken (--accent-primary) so its rows read distinctly from the muted
  // `standard` rows that dominate the list, instead of falling through to it.
  'automations-host': {
    bg: 'bg-[color:var(--bg-selected)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    glyph: 'text-[color:var(--accent-primary)]',
  },
  standard: {
    bg: 'bg-[color:var(--bg-selected)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    glyph: 'text-[color:var(--text-muted)]',
  },
}

// Effective accent for a workspace row. When the workspace has a highlight
// color, it overrides the mode accent everywhere except the icon glyph
// shape (which still tells the user which mode the workspace is in). A workspace
// whose type module is disabled (or an unknown/standard mode) degrades to the
// generic standard accent, matching the generic icon WorkspaceTypeIcon renders
// for the same row (AC4 disabled-module contract).
export function rowAccent(workspace: Workspace, moduleOverrides: ModuleEnablementOverrides): RowAccent {
  const highlight = workspace.highlight?.color
  if (highlight) {
    const swatch = getHighlightSwatch(highlight)
    return {
      bg: swatch.bg,
      text: swatch.text,
      shadow: swatch.shadow,
      glyph: `text-[${swatch.hex}]`,
    }
  }
  const effectiveMode: Workspace['mode'] = resolveEnabledWorkspaceType(workspace.mode, moduleOverrides)
    ? workspace.mode
    : 'standard'
  return modeAccents[effectiveMode] ?? modeAccents.standard
}

// A user-set highlight colour is workspace identity, not selection, so its rail
// reads the same whether or not the row is the active one. Rows with no
// highlight keep the base transparent 4px border and show no rail at all.
function highlightRailClass(workspace: Workspace): string {
  if (!hasHighlightOverride(workspace.highlight)) return ''
  return `border-l-[4px] ${getHighlightSwatch(workspace.highlight!.color!).border}`
}

// The selected row is its fill and its ink lift — no left bar of its own. The
// base row keeps `border-l-[4px] border-l-transparent`, so a highlight rail
// appears and disappears without shifting the row's content sideways.
function activeRowClass(workspace: Workspace, moduleOverrides: ModuleEnablementOverrides): string {
  const accent = rowAccent(workspace, moduleOverrides)
  return `${highlightRailClass(workspace)} ${accent.bg} ${accent.text} ${accent.shadow}`
}

// Class fragment applied to inactive rows that have a highlight color set, so
// the user spots their highlighted workspaces at a glance even when not active.
// The colored left rail plus a dimmed full-width tint of the same hue — the
// quiet half of the dim/bright pair; selecting the row swaps to the brighter
// `bg` fill in `activeRowClass`.
function inactiveHighlightClass(workspace: Workspace): string {
  if (!hasHighlightOverride(workspace.highlight)) return ''
  const swatch = getHighlightSwatch(workspace.highlight!.color!)
  return `${highlightRailClass(workspace)} ${swatch.dimBg}`
}

// Chat/session workspaces use the terminal activity idiom: active work earns a
// pulsing green dot, while idle rows fall back to minute-based recency.
// Sprint and automation workspaces bypass this through their run-glyph provider.
function activityTone(activity: Activity): { tone: Tone; pulse: boolean } | null {
  if (activity === 'needs-input') return { tone: 'warn', pulse: true }
  if (activity === 'working') return { tone: 'good', pulse: true }
  if (activity === 'failed') return { tone: 'error', pulse: false }
  return null
}

function activityLabel(activity: Activity): string {
  if (activity === 'needs-input') return 'Workspace needs input'
  if (activity === 'working') return 'Workspace agents working'
  if (activity === 'failed') return 'Workspace agent failed'
  return 'Workspace idle'
}

function reorderWithinFolder(
  workspaces: Workspace[],
  draggedId: WorkspaceId,
  targetId: WorkspaceId,
  position: 'before' | 'after'
): WorkspaceId[] {
  const next = [...workspaces]
  const draggedIdx = next.findIndex((w) => w.id === draggedId)
  if (draggedIdx === -1) return next.map((w) => w.id)
  const [dragged] = next.splice(draggedIdx, 1)
  let targetIdx = next.findIndex((w) => w.id === targetId)
  if (targetIdx === -1) {
    next.push(dragged)
  } else {
    if (position === 'after') targetIdx += 1
    next.splice(targetIdx, 0, dragged)
  }
  return next.map((w) => w.id)
}

function reorderFolders(
  workspaces: Workspace[],
  draggedKey: string,
  targetKey: string,
  position: 'before' | 'after'
): WorkspaceId[] {
  const groups = buildFolderGroups(workspaces)
  const draggedGroup = groups.find((g) => g.key === draggedKey)
  if (!draggedGroup) return workspaces.map((w) => w.id)
  const remaining = groups.filter((g) => g.key !== draggedKey)
  let targetIdx = remaining.findIndex((g) => g.key === targetKey)
  if (targetIdx === -1) {
    remaining.push(draggedGroup)
  } else {
    if (position === 'after') targetIdx += 1
    remaining.splice(targetIdx, 0, draggedGroup)
  }
  return remaining.flatMap((g) => g.workspaces.map((w) => w.id))
}

function didWorkspaceDragLeaveSidebar(event: React.DragEvent, sidebar: HTMLElement | null): boolean {
  if (!sidebar) return false
  const rect = sidebar.getBoundingClientRect()
  const clientOutside = event.clientX < rect.left
    || event.clientX > rect.right
    || event.clientY < rect.top
    || event.clientY > rect.bottom
  const screenLeft = window.screenX + rect.left
  const screenRight = window.screenX + rect.right
  const screenTop = window.screenY + rect.top
  const screenBottom = window.screenY + rect.bottom
  const screenOutside = event.screenX < screenLeft
    || event.screenX > screenRight
    || event.screenY < screenTop
    || event.screenY > screenBottom
  return clientOutside || screenOutside
}

function workspaceHasOnDiskState(workspace: Workspace): boolean {
  if (workspace.mode === 'sprintengine') return Boolean(workspace.sprintEngineContext?.teamDirectoryPath)
  return false
}

// A Cancel-sprint action is offered only for a live Sprint Engine run: the
// right mode, a resolved run file to target, and not already in a terminal
// state. Terminality is read from whichever signal is hydrated — the projection
// flags when present, else the persisted automation runtime state — so a
// canceled/completed run in the sidebar never re-offers Cancel.
//
// Sprint runs left the Projects list in item 1767, so no row reaches this today:
// Cancel sprint lives on the run board's own command menu, which the Sprints
// door canvas mounts. This row path is kept intact — not deleted — because
// hiding the rows is one revertible predicate (`isHiddenFromRail`), and reverting
// it must bring the rows back whole.
function isCancelableSprintEngineWorkspace(workspace: Workspace): boolean {
  if (workspace.mode !== 'sprintengine') return false
  if (!workspace.sprintEngineContext?.statePath) return false
  const state = workspace.sprintEngineState
  if (state && (isCanceledSprintEngineRun(state) || isCompletedSprintEngineRun(state))) return false
  const runtimeState = workspace.sprintEngineAutoState?.runtimeState
  return runtimeState !== 'canceled' && runtimeState !== 'complete'
}

// The one fold idiom for older rows: hidden rows reveal FOLD_PAGE_SIZE at a
// time ("Show 5 more" → 5 more → …), and whenever anything extra is revealed a
// "Show fewer" affordance snaps the fold back to the at-rest view.
function ShowOlderRow({
  hiddenTotal,
  revealed,
  controlsId,
  onShowMore,
  onShowFewer,
}: {
  hiddenTotal: number
  revealed: number
  controlsId: string
  onShowMore: () => void
  onShowFewer: () => void
}) {
  const remaining = hiddenTotal - revealed
  const rowClass =
    'flex h-control-xs cursor-pointer select-none items-center gap-1.5 rounded-md text-meta text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]'
  return (
    <div className="mx-1.5 my-0.5 flex items-center gap-1">
      {remaining > 0 ? (
        <button
          type="button"
          onClick={onShowMore}
          aria-expanded={revealed > 0}
          aria-controls={controlsId}
          className={`${rowClass} min-w-0 flex-1 pl-[30px] pr-1.5`}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className={`icon-xs shrink-0 text-[color:var(--text-disabled)] transition-transform ${
              revealed > 0 ? '' : '-rotate-90'
            }`}
          >
            <path d="M5 6L8 9L11 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="truncate tabular-nums">{`Show ${Math.min(FOLD_PAGE_SIZE, remaining)} more`}</span>
        </button>
      ) : null}
      {revealed > 0 ? (
        <button
          type="button"
          onClick={onShowFewer}
          aria-controls={controlsId}
          className={`${rowClass} shrink-0 px-2 ${remaining > 0 ? '' : 'flex-1 pl-[30px]'}`}
        >
          Show fewer
        </button>
      ) : null}
    </div>
  )
}

export default function WorkspaceSidebar({
  workspaces,
  activeWorkspaceId,
  workspaceWindowId,
  isDetachedWindow,
  sidebarCollapsed,
  chromeSlot,
  contextRail,
  contextRailActive = false,
  activityByWorkspaceId,
  residentWorkspaceIds,
  terminalRecencyByWorkspaceId,
  onSelectWorkspace,
  onMoveWorkspaceToNewWindow,
  onMoveWorkspaceToMainWindow,
  onCloseWorkspace,
  onDeleteWorkspaceWithState,
  onForgetFolder,
  onNewWorkspace,
  onNewWorkspaceInFolder,
  onNewChat,
  onNewWorkspaceMode,
  onNewChatInFolder,
  onRevealFolder,
  onSetSidebarCollapsed,
  sidebarWidth,
  onSetSidebarWidth,
  authState,
  authMessage,
  accountOpen,
  setAccountOpen,
  startLogin,
  refreshAuthState,
  logout,
  openSettings,
  settingsOpen,
}: WorkspaceSidebarProps) {
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace)
  const reorderWorkspaces = useWorkspaceStore((s) => s.reorderWorkspaces)
  const setWorkspaceHighlight = useWorkspaceStore((s) => s.setWorkspaceHighlight)
  const clearWorkspaceHighlight = useWorkspaceStore((s) => s.clearWorkspaceHighlight)
  const addWorkspaceFromStore = useWorkspaceStore((s) => s.addWorkspace)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const updateLayout = useWorkspaceStore((s) => s.updateLayout)
  const moveAgentToWorkspace = useWorkspaceStore((s) => s.moveAgentToWorkspace)
  const moveOpenFileToWorkspace = useWorkspaceStore((s) => s.moveOpenFileToWorkspace)
  // Passed to WorkspaceTypeIcon so a disabled-module workspace row degrades to
  // the generic glyph (AC4) instead of its tool icon.
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  // Rows for the "+" create menu, matching the creation hub rail's list/order.
  const createMenuModels = useMemo(() => buildModeModels(moduleOverrides), [moduleOverrides])
  // A door-routed full-page surface owns the card region (global-surfaces epic
  // 1704). While one is active no project row is "current" — the door row carries
  // the selection instead, so the sidebar shows exactly one selected thing. This
  // resolves + module-gates the active surface exactly as WorkspaceManager does
  // for the mount, so the two agree: a stale id whose surface is unregistered or
  // whose module was disabled falls back to the workspace (region shows it, and a
  // project row re-selects) rather than leaving nothing selected.
  const activeGlobalSurface = useWorkspaceStore((s) => s.activeGlobalSurface)
  const globalSurfaceActive = useMemo(() => {
    if (!activeGlobalSurface) return false
    const entry = getRendererHost().getGlobalSurface(activeGlobalSurface)
    return entry !== undefined && selectModuleEnabled(moduleOverrides, entry.moduleId)
  }, [activeGlobalSurface, moduleOverrides])
  // Module-contributed top-nav doors (the sidebar-nav host contribution point).
  // The Roadmap door now rides this registry rather than being hardcoded here:
  // it registers unconditionally at boot and is filtered by its module's live
  // enablement, so toggling Roadmap (or a Sprint-Engine/Automations dependency)
  // shows/hides the door without a reload. Memoized on the enablement overrides
  // so the array is stable between toggles.
  const moduleNavEntries = useMemo(
    () => getRendererHost().getSidebarNavEntries((id) => selectModuleEnabled(moduleOverrides, id)),
    [moduleOverrides],
  )
  const now = useRelativeNow()

  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({})
  // How many folded (stale) rows each folder has revealed via "Show N older" —
  // paged in FOLD_PAGE_SIZE steps rather than an all-or-nothing toggle.
  const [revealedStaleFolders, setRevealedStaleFolders] = useState<Record<string, number>>({})
  const [starredCollapsed, setStarredCollapsed] = useState(false)
  const [renamingId, setRenamingId] = useState<WorkspaceId | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [contextMenu, setContextMenu] = useState<{ workspaceId: WorkspaceId; x: number; y: number } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ folderKey: string; x: number; y: number } | null>(null)
  // The "+" create menu beside New chat: one row per creatable type, each
  // opening the creation hub preselected (chat/standard route to their own
  // dedicated openers).
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirmClose, setConfirmClose] = useState<WorkspaceId | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<WorkspaceId | null>(null)
  const [confirmCancelSprint, setConfirmCancelSprint] = useState<WorkspaceId | null>(null)
  const [cancelSprintBusy, setCancelSprintBusy] = useState(false)
  const [confirmForget, setConfirmForget] = useState<string | null>(null)
  const [deleteTypedName, setDeleteTypedName] = useState('')

  const renameInputRef = useRef<HTMLInputElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  // Roving-tabindex tree: `rovingKey` is the row (by its render key) that holds
  // the single tab stop. Arrow/Home/End move focus between the treeitems that
  // are actually in the DOM (folded/collapsed rows are absent), so navigation
  // follows what the user sees. treeRef scopes the query to this tree.
  const treeRef = useRef<HTMLElement>(null)
  const [rovingKey, setRovingKey] = useState<string | null>(null)

  const getTreeRows = useCallback((): HTMLElement[] => {
    const root = treeRef.current
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]'))
  }, [])

  // Drilling into a surface hides this rail (item 1993), and hiding a scrollport
  // drops its offset to zero — so Back would return the workspaces rail scrolled
  // to the top instead of returning the rail the surface replaced. The offset is
  // recorded as the user scrolls (a ref write, never a re-render) and put back
  // before the restored rail paints.
  const treeScrollTopRef = useRef(0)
  useEffect(() => {
    if (contextRailActive) return
    const node = treeRef.current
    if (node) node.scrollTop = treeScrollTopRef.current
  }, [contextRailActive])

  const handleTreeRowKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>, workspaceId: WorkspaceId) => {
      // Only the row itself steers the tree; keys from a focused child control
      // (rename input, row-action buttons) keep their own behavior.
      if (event.target !== event.currentTarget) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onSelectWorkspace(workspaceId)
        return
      }
      if (
        event.key !== 'ArrowDown'
        && event.key !== 'ArrowUp'
        && event.key !== 'Home'
        && event.key !== 'End'
      ) {
        return
      }
      const rows = getTreeRows()
      if (rows.length === 0) return
      event.preventDefault()
      const currentIndex = rows.indexOf(event.currentTarget)
      let nextIndex = currentIndex
      if (event.key === 'ArrowDown') nextIndex = currentIndex + 1
      else if (event.key === 'ArrowUp') nextIndex = currentIndex - 1
      else if (event.key === 'Home') nextIndex = 0
      else if (event.key === 'End') nextIndex = rows.length - 1
      nextIndex = Math.max(0, Math.min(nextIndex, rows.length - 1))
      const target = rows[nextIndex]
      if (!target) return
      target.focus()
      setRovingKey(target.dataset.rowKey ?? null)
    },
    [getTreeRows, onSelectWorkspace]
  )
  // True while the user is dragging the resize handle — suppresses the width
  // glide so the rail tracks the pointer instead of lagging behind a 150ms
  // transition.
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  // Live width during an active drag. The drag writes width straight to the
  // sidebar element's style (see apply()) instead of the store, so no frame
  // pays for a store mutation — which in this app means re-serializing the whole
  // persisted workspace registry (~3× per frame in the persist adapter) plus a
  // full WorkspaceManager re-render. This ref is the drag's source of truth so a
  // stray re-render mid-drag (e.g. a workspace status tick) re-reads the live
  // width instead of snapping back to the stale store value. Committed to the
  // store once on pointer-up.
  const dragWidthRef = useRef<number | null>(null)

  // Drag the right-edge handle to resize the expanded sidebar; drag it close to
  // the left and the rail collapses to the icon strip. Pointer math is shared
  // with the store via resolveSidebarResize so the snap threshold is single-
  // sourced. rAF-coalesced so a fast drag does at most one update per frame, and
  // each frame is a pure DOM width write — the store is touched only on
  // pointer-up (final width) and when crossing the collapse/expand boundary.
  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      const startX = event.clientX
      const startWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth
      let collapsed = sidebarCollapsed
      let frame: number | null = null
      let pendingX = startX
      dragWidthRef.current = startWidth

      const apply = () => {
        frame = null
        const outcome = resolveSidebarResize(startWidth + (pendingX - startX))
        if (outcome.kind === 'collapse') {
          if (!collapsed) {
            collapsed = true
            dragWidthRef.current = null
            onSetSidebarCollapsed(true)
          }
          return
        }
        if (collapsed) {
          collapsed = false
          onSetSidebarCollapsed(false)
        }
        // Per-frame update stays in the DOM: no store mutation, so no registry
        // re-serialization and no app-wide re-render while dragging.
        dragWidthRef.current = outcome.width
        if (sidebarRef.current) sidebarRef.current.style.width = `${outcome.width}px`
      }
      const onMove = (e: PointerEvent) => {
        pendingX = e.clientX
        if (frame === null) frame = window.requestAnimationFrame(apply)
      }
      const onUp = () => {
        if (frame !== null) window.cancelAnimationFrame(frame)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        // Commit the final width to the store exactly once (skipped if the drag
        // ended in the collapsed state, which already updated the store).
        const finalWidth = dragWidthRef.current
        dragWidthRef.current = null
        if (finalWidth !== null && !collapsed) onSetSidebarWidth(finalWidth)
        setIsResizingSidebar(false)
      }
      setIsResizingSidebar(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [sidebarCollapsed, sidebarWidth, onSetSidebarCollapsed, onSetSidebarWidth]
  )

  // Keyboard resizing for the separator handle: arrows nudge width (and cross
  // the collapse/expand boundary), Home restores the default width.
  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const STEP = 16
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (sidebarCollapsed) return
        const next = sidebarWidth - STEP
        if (next < SIDEBAR_MIN_WIDTH) onSetSidebarCollapsed(true)
        else onSetSidebarWidth(next)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (sidebarCollapsed) {
          onSetSidebarCollapsed(false)
          onSetSidebarWidth(SIDEBAR_MIN_WIDTH)
        } else {
          onSetSidebarWidth(sidebarWidth + STEP)
        }
      } else if (event.key === 'Home') {
        event.preventDefault()
        if (sidebarCollapsed) onSetSidebarCollapsed(false)
        onSetSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
      }
    },
    [sidebarCollapsed, sidebarWidth, onSetSidebarCollapsed, onSetSidebarWidth]
  )

  // Double-click resets to the default width (and expands if collapsed).
  const handleResizeDoubleClick = useCallback(() => {
    if (sidebarCollapsed) onSetSidebarCollapsed(false)
    onSetSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
  }, [sidebarCollapsed, onSetSidebarCollapsed, onSetSidebarWidth])
  const dragRef = useRef<
    | { type: 'workspace'; id: WorkspaceId; folderKey: string }
    | { type: 'folder'; folderKey: string }
    | null
  >(null)
  const [dropIndicator, setDropIndicator] = useState<
    | { kind: 'workspace'; targetId: WorkspaceId; position: 'before' | 'after' }
    | { kind: 'folder'; targetKey: string; position: 'before' | 'after' }
    | null
  >(null)
  const [tabDropTarget, setTabDropTarget] = useState<
    | { kind: 'new' }
    | { kind: 'workspace'; id: WorkspaceId }
    | null
  >(null)

  // Rail-hidden workspaces — the background Automations host and, since item
  // 1767, every sprint-run workspace — stay in the store and in window
  // assignments but never render as rail rows. Every presentation path below —
  // folder groups, starred — derives from this list, while drag-reorder still
  // stitches against the full `workspaces` array so a hidden workspace keeps its
  // place in the persisted order. Cross-workspace search now lives in the
  // global-search palette (T6), not a sidebar box.
  const railWorkspaces = useMemo(
    () =>
      workspaces.filter(
        (workspace) => !isHiddenFromRail(workspace) && !isArchivedWorkspace(workspace)
      ),
    [workspaces]
  )

  const groups = useMemo(() => buildFolderGroups(railWorkspaces), [railWorkspaces])

  // A workspace is "live" while it shows a status dot — working, failed, or
  // waiting on input. Live rows sort above idle ones in the activity ordering.
  // Starred workspaces surface in most-recently-worked order — by how long ago
  // each was worked on, not by live status, so opening one never bumps it. This
  // supersedes manual drag position within the Starred section.
  const starredWorkspaces = useMemo(
    () =>
      sortWorkspacesByActivity(
        railWorkspaces.filter((workspace) => isStarred(workspace.highlight))
      ),
    [railWorkspaces]
  )

  const workspaceById = useMemo(() => {
    const map = new Map<WorkspaceId, Workspace>()
    for (const ws of workspaces) map.set(ws.id, ws)
    return map
  }, [workspaces])

  // A workspace stays out of the per-folder "Show older" fold while it is the
  // active one, starred, or busy — a workspace waiting on input or running a
  // live agent must never hide itself, even if its last terminal output was
  // days ago.
  const isWorkspacePinned = useCallback(
    (workspace: Workspace) => {
      if (workspace.id === activeWorkspaceId) return true
      if (isStarred(workspace.highlight)) return true
      return (activityByWorkspaceId[workspace.id] ?? 'idle') !== 'idle'
    },
    [activeWorkspaceId, activityByWorkspaceId]
  )

  // Seed / repair the single tab stop. When no row owns it (first paint) or the
  // owning row has left the DOM (folder collapsed, workspace closed), hand it to
  // the active row if present, else the first row.
  useEffect(() => {
    const rows = getTreeRows()
    if (rows.length === 0) return
    if (rovingKey && rows.some((el) => el.dataset.rowKey === rovingKey)) return
    const activeRow = rows.find((el) => el.getAttribute('aria-current') === 'true')
    setRovingKey((activeRow ?? rows[0]).dataset.rowKey ?? null)
  }, [
    getTreeRows,
    rovingKey,
    railWorkspaces,
    groups,
    starredWorkspaces,
    collapsedFolders,
    revealedStaleFolders,
    starredCollapsed,
    activeWorkspaceId,
    globalSurfaceActive,
  ])

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  const startRename = useCallback((workspace: Workspace) => {
    setRenamingId(workspace.id)
    setRenameValue(workspace.name)
  }, [])

  // F2 on the active workspace begins inline rename.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'F2') return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (renamingId || !activeWorkspaceId) return
      const workspace = workspaceById.get(activeWorkspaceId)
      if (!workspace) return
      event.preventDefault()
      startRename(workspace)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeWorkspaceId, renamingId, workspaceById, startRename])

  const commitRename = useCallback(() => {
    if (renamingId) renameWorkspace(renamingId, renameValue)
    setRenamingId(null)
  }, [renamingId, renameValue, renameWorkspace])

  const handleClose = useCallback(
    (workspaceId: WorkspaceId) => {
      const workspace = workspaceById.get(workspaceId)
      if (!workspace) return
      const activity = activityByWorkspaceId[workspaceId] ?? 'idle'
      if (activity === 'working' || activity === 'failed' || activity === 'needs-input') {
        setConfirmClose(workspaceId)
        return
      }
      onCloseWorkspace(workspaceId)
    },
    [workspaceById, activityByWorkspaceId, onCloseWorkspace]
  )

  // Cancel a Sprint Engine run from the sidebar: run the engine cancel op, then
  // force a projection refresh so the run glyph and the Backlog run-link settle
  // on the canceled state immediately (the poller's routine ticks are display-
  // only once the run turns dormant, so the forced refresh is what recolors the
  // link chip). A failure surfaces as a diagnostic rather than silently leaving
  // a half-canceled run.
  const cancelSprintForWorkspace = useCallback(
    async (workspaceId: WorkspaceId) => {
      const workspace = workspaceById.get(workspaceId)
      const statePath = workspace?.sprintEngineContext?.statePath
      if (!workspace || !statePath || cancelSprintBusy) return
      setCancelSprintBusy(true)
      try {
        const result = await window.api.cancelSprintEngineRun({ statePath })
        if (!result.ok) throw new Error(result.message ?? 'Canceling the sprint failed.')
        await refreshSprintEngineWorkspaceProjection({
          workspace,
          tokens: new Map(),
          cause: 'manual',
          force: true,
        })
      } catch (error) {
        await publishDiagnostic({
          level: 'warning',
          source: 'sprintengine',
          title: 'Cancel sprint failed',
          message: error instanceof Error ? error.message : String(error),
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        })
      } finally {
        setCancelSprintBusy(false)
      }
    },
    [workspaceById, cancelSprintBusy]
  )

  const handleRowDragStart = (event: React.DragEvent, workspace: Workspace, fKey: string) => {
    dragRef.current = { type: 'workspace', id: workspace.id, folderKey: fKey }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(DRAG_MIME_WORKSPACE, workspace.id)
  }

  const handleRowDragOver = (event: React.DragEvent, targetWorkspace: Workspace, fKey: string) => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.type !== 'workspace') return
    if (drag.folderKey !== fKey) {
      event.dataTransfer.dropEffect = 'none'
      setDropIndicator(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const position: 'before' | 'after' = (event.clientY - rect.top) < rect.height / 2 ? 'before' : 'after'
    setDropIndicator({ kind: 'workspace', targetId: targetWorkspace.id, position })
  }

  const handleRowDrop = (event: React.DragEvent, targetWorkspace: Workspace, fKey: string) => {
    const drag = dragRef.current
    dragRef.current = null
    setDropIndicator(null)
    if (!drag || drag.type !== 'workspace') return
    if (drag.folderKey !== fKey) return
    event.preventDefault()
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const position: 'before' | 'after' = (event.clientY - rect.top) < rect.height / 2 ? 'before' : 'after'
    if (drag.id === targetWorkspace.id) return

    const folderWorkspaces = workspaces.filter((w) => folderKey(w.folderPath) === fKey)
    const localOrderedIds = reorderWithinFolder(folderWorkspaces, drag.id, targetWorkspace.id, position)

    // Stitch: rebuild the global workspace order, replacing the contiguous block
    // for this folder with the new local order while leaving every other folder
    // alone.
    const localSet = new Set(localOrderedIds)
    const globalOrder: WorkspaceId[] = []
    let injected = false
    for (const ws of workspaces) {
      if (localSet.has(ws.id)) {
        if (!injected) {
          for (const id of localOrderedIds) globalOrder.push(id)
          injected = true
        }
      } else {
        globalOrder.push(ws.id)
      }
    }
    reorderWorkspaces(globalOrder)
  }

  const handleFolderDragStart = (event: React.DragEvent, fKey: string) => {
    dragRef.current = { type: 'folder', folderKey: fKey }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(DRAG_MIME_FOLDER, fKey)
  }

  const handleFolderDragOver = (event: React.DragEvent, fKey: string) => {
    const drag = dragRef.current
    if (!drag || drag.type !== 'folder') return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const position: 'before' | 'after' = (event.clientY - rect.top) < rect.height / 2 ? 'before' : 'after'
    setDropIndicator({ kind: 'folder', targetKey: fKey, position })
  }

  const handleFolderDrop = (event: React.DragEvent, fKey: string) => {
    const drag = dragRef.current
    dragRef.current = null
    setDropIndicator(null)
    if (!drag || drag.type !== 'folder') return
    event.preventDefault()
    if (drag.folderKey === fKey) return
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const position: 'before' | 'after' = (event.clientY - rect.top) < rect.height / 2 ? 'before' : 'after'
    const newOrder = reorderFolders(workspaces, drag.folderKey, fKey, position)
    reorderWorkspaces(newOrder)
  }

  const handleDragEnd = (event: React.DragEvent) => {
    const drag = dragRef.current
    if (drag?.type === 'workspace' && didWorkspaceDragLeaveSidebar(event, sidebarRef.current)) {
      onMoveWorkspaceToNewWindow(drag.id, { screenX: event.screenX, screenY: event.screenY })
    }
    dragRef.current = null
    setDropIndicator(null)
    setTabDropTarget(null)
  }

  const migrateTabSideEffects = useCallback(
    (payload: TabDragPayload, destWorkspaceId: WorkspaceId) => {
      if (payload.sourceWorkspaceId === destWorkspaceId) return
      if (payload.component === 'agent') {
        const agentId =
          payload.config && typeof payload.config.agentId === 'string'
            ? payload.config.agentId
            : null
        if (agentId) {
          moveAgentToWorkspace(payload.sourceWorkspaceId, destWorkspaceId, agentId)
        }
        return
      }
      if (payload.component === 'file-editor') {
        const filePath =
          payload.config && typeof payload.config.filePath === 'string'
            ? payload.config.filePath
            : null
        if (filePath) {
          moveOpenFileToWorkspace(payload.sourceWorkspaceId, destWorkspaceId, filePath)
        }
      }
    },
    [moveAgentToWorkspace, moveOpenFileToWorkspace]
  )

  const handleTabDragOverNew = useCallback((event: React.DragEvent) => {
    if (!dataTransferHasTabDrag(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setTabDropTarget({ kind: 'new' })
  }, [])

  const handleTabDragLeaveNew = useCallback(() => {
    setTabDropTarget((current) => (current?.kind === 'new' ? null : current))
  }, [])

  const handleTabDropOnNew = useCallback(
    (event: React.DragEvent) => {
      const payload = readTabDragPayload(event.dataTransfer)
      setTabDropTarget(null)
      if (!payload) return
      event.preventDefault()
      event.stopPropagation()

      // Prefer the live-model spec (has the most up-to-date className/config)
      // and fall back to the drag payload if the source model has been
      // unmounted between drag start and drop.
      const liveSpec =
        extractTabSpec(payload.sourceWorkspaceId, payload.tabId) ?? null
      const spec: CrossWorkspaceTabSpec = liveSpec ?? {
        component: payload.component,
        name: payload.name,
        config: payload.config,
        className: payload.className,
      }

      const sourceWorkspace = workspaceById.get(payload.sourceWorkspaceId) ?? null
      const inheritedFolderPath = sourceWorkspace?.folderPath ?? null

      const syntheticTemplate: LayoutTemplate = {
        id: `extracted-tab-${Date.now()}`,
        name: payload.name || 'Workspace',
        description: '',
        previewSlots: [],
        layout: buildSingleTabLayoutModel(spec),
      }

      const newWorkspaceId = addWorkspaceFromStore(syntheticTemplate, {
        name: payload.name || undefined,
        folderPath: inheritedFolderPath,
        windowId: workspaceWindowId,
      })

      migrateTabSideEffects(payload, newWorkspaceId)
      removeTab(payload.sourceWorkspaceId, payload.tabId, { preserveRuntime: true })
    },
    [addWorkspaceFromStore, migrateTabSideEffects, workspaceById, workspaceWindowId]
  )

  const handleTabDragOverRow = useCallback(
    (event: React.DragEvent, workspace: Workspace) => {
      if (!dataTransferHasTabDrag(event.dataTransfer)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setTabDropTarget({ kind: 'workspace', id: workspace.id })
    },
    []
  )

  const handleTabDragLeaveRow = useCallback((workspaceId: WorkspaceId) => {
    setTabDropTarget((current) =>
      current?.kind === 'workspace' && current.id === workspaceId ? null : current
    )
  }, [])

  const handleTabDropOnRow = useCallback(
    (event: React.DragEvent, workspace: Workspace) => {
      const payload = readTabDragPayload(event.dataTransfer)
      setTabDropTarget(null)
      if (!payload) return
      event.preventDefault()
      event.stopPropagation()

      // No-op if dropped on the source workspace itself.
      if (payload.sourceWorkspaceId === workspace.id) return

      const liveSpec =
        extractTabSpec(payload.sourceWorkspaceId, payload.tabId) ?? null
      const spec: CrossWorkspaceTabSpec = liveSpec ?? {
        component: payload.component,
        name: payload.name,
        config: payload.config,
        className: payload.className,
      }

      const destinationModel = getModel(workspace.id)
      if (destinationModel) {
        addTabAsNewColumn(workspace.id, spec)
      } else {
        // Destination is unmounted; mutate persisted JSON so the new tab is
        // present when the layout next mounts.
        const nextLayout = appendTabAsNewColumnInJson(workspace.layoutModel, spec)
        updateLayout(workspace.id, nextLayout)
      }

      migrateTabSideEffects(payload, workspace.id)
      removeTab(payload.sourceWorkspaceId, payload.tabId, { preserveRuntime: true })
      setActiveWorkspace(workspace.id)
    },
    [migrateTabSideEffects, setActiveWorkspace, updateLayout]
  )

  const renderWorkspaceRow = (workspace: Workspace, fKey: string, options?: { keyPrefix?: string }) => {
    // When a door-routed full-page surface owns the card region (epic 1704), no
    // workspace row is "current" — the door row carries the selection, so a
    // highlighted project row here would be a second, conflicting selected state.
    const active = !globalSurfaceActive && workspace.id === activeWorkspaceId
    const activity = activityByWorkspaceId[workspace.id] ?? 'idle'
    const tone = activityTone(activity)
    const recency = terminalRecencyByWorkspaceId[workspace.id]
    // Sprint Engine rows carry the run's lifecycle glyph in the status slot
    // instead of the dot + recency idiom: the run state (spinner / needs input
    // / paused / failed / done) is the signal a sprint workspace wants.
    // Recency still drives ordering and survives in the glyph's tooltip.
    const runGlyph = deriveWorkspaceRunGlyph(workspace)
    const runGlyphRecencyAgo =
      runGlyph && typeof recency?.lastInputAt === 'number'
        ? formatRelativeMsAgo(recency.lastInputAt, now)
        : null
    const runGlyphLabel = runGlyph
      ? `${runGlyph.label}${runGlyphRecencyAgo ? ` · last typed ${runGlyphRecencyAgo}` : ''}`
      : null
    const idleRecencyText = typeof recency?.idleSince === 'number'
      ? formatRelativeMs(recency.idleSince, now)
      : ''
    const showRecencyText =
      !runGlyph
      && activity === 'idle'
      && !!recency
      && !recency.hasRunning
      && !!idleRecencyText
    const folderMissing = workspace.folderMissing === true
    const starred = isStarred(workspace.highlight)
    // "Hot": at least one resident (live-PTY) agent — instant to switch into.
    // Bolded below so suspended/exited workspaces read as the quieter state.
    const resident = residentWorkspaceIds.has(workspace.id)
    const highlighted = hasHighlightOverride(workspace.highlight)
    const dropMark =
      dropIndicator?.kind === 'workspace' && dropIndicator.targetId === workspace.id
        ? dropIndicator.position
        : null
    const isTabDropTarget =
      tabDropTarget?.kind === 'workspace' && tabDropTarget.id === workspace.id
    const rowKey = `${options?.keyPrefix ?? ''}${workspace.id}`

    return (
      <div
        key={rowKey}
        data-row-key={rowKey}
        // Roving tabindex: exactly one treeitem is in the tab order at a time,
        // and Arrow/Home/End move focus between rows (handleTreeRowKeyDown).
        tabIndex={rovingKey === rowKey ? 0 : -1}
        onFocus={() => setRovingKey(rowKey)}
        onKeyDown={(event) => handleTreeRowKeyDown(event, workspace.id)}
        draggable={!renamingId}
        onDragStart={(event) => handleRowDragStart(event, workspace, fKey)}
        onDragOver={(event) => {
          if (dataTransferHasTabDrag(event.dataTransfer)) {
            handleTabDragOverRow(event, workspace)
            return
          }
          handleRowDragOver(event, workspace, fKey)
        }}
        onDragLeave={() => handleTabDragLeaveRow(workspace.id)}
        onDrop={(event) => {
          if (dataTransferHasTabDrag(event.dataTransfer)) {
            handleTabDropOnRow(event, workspace)
            return
          }
          handleRowDrop(event, workspace, fKey)
        }}
        onDragEnd={handleDragEnd}
        onClick={() => {
          if (renamingId) return
          onSelectWorkspace(workspace.id)
        }}
        onDoubleClick={(event) => {
          event.stopPropagation()
          startRename(workspace)
        }}
        onMouseDown={(event) => {
          if (event.button === 1) {
            event.preventDefault()
            handleClose(workspace.id)
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          setContextMenu({ workspaceId: workspace.id, x: event.clientX, y: event.clientY })
        }}
        className={`interactive group relative mx-1.5 my-0.5 flex h-control-sm cursor-pointer select-none items-center gap-2 rounded-md border-l-[4px] border-l-transparent pl-[26px] pr-1.5 text-heading ${FOCUS_RING_CLASS} ${
          active
            ? activeRowClass(workspace, moduleOverrides)
            : highlighted
              ? `${inactiveHighlightClass(workspace)} text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]`
              : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]'
        } ${folderMissing ? 'opacity-70' : ''}`}
        role="treeitem"
        aria-current={active ? 'true' : undefined}
      >
        {dropMark === 'before' ? (
          <span aria-hidden="true" className="absolute inset-x-1 top-[-1px] h-[2px] rounded bg-[color:var(--accent-primary)]" />
        ) : null}
        {dropMark === 'after' ? (
          <span aria-hidden="true" className="absolute inset-x-1 bottom-[-1px] h-[2px] rounded bg-[color:var(--accent-primary)]" />
        ) : null}
        {isTabDropTarget ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-[color:var(--accent-primary)] ring-offset-0"
          />
        ) : null}

        {/* The title starts flush with the row's content edge — the
            workspace-type icon chip is dropped so the name gets the width. Mode
            identity survives in the colored left rail / accent (active +
            highlighted rows), the trailing run glyph, and the inline sprint
            mark below. */}
        {renamingId === workspace.id ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={commitRename}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') setRenamingId(null)
              event.stopPropagation()
            }}
            className={`min-w-0 flex-1 rounded border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-1.5 py-0 text-heading text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
          />
        ) : (
          <span
            className={`flex min-w-0 flex-1 items-center gap-1.5 ${folderMissing ? 'line-through decoration-[color:var(--text-subtle)]' : ''}`}
          >
            {starred ? (
              <StarGlyph
                filled
                className="icon-xs shrink-0 text-[color:var(--tone-warn)]"
                label="Starred"
              />
            ) : null}
            {workspace.mode === 'sprintengine' ? (
              <SprintEngineMarkIcon className="icon-xs shrink-0 text-[color:var(--tool-sprintengine-ink)]" />
            ) : null}
            <TruncatedText
              as="span"
              text={workspace.name}
              className={`min-w-0 flex-1 ${resident ? 'font-semibold text-[color:var(--text-strong)]' : ''}`}
            />
            {resident ? <span className="sr-only"> (agents resident)</span> : null}
          </span>
        )}

        {folderMissing ? (
          <svg
            className="icon-xs shrink-0 text-[color:var(--tone-warn)]"
            viewBox="0 0 16 16"
            fill="none"
            aria-label="Folder missing"
          >
            <path d="M8 1L15 14H1L8 1Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="M8 6V9M8 11.5V11.51" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        ) : null}

        <span className="relative ml-auto flex h-5 min-w-[44px] shrink-0 items-center justify-end">
          <span className="inline-flex items-center gap-1 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
            {runGlyph && runGlyphLabel ? (
              <Tooltip content={runGlyphLabel}>
                <LifecycleGlyph state={runGlyph.state} live={runGlyph.live} label={runGlyphLabel} />
              </Tooltip>
            ) : null}
            {/* Active work earns the three-dot working marker; the other
                attention states keep the tone dot. */}
            {!runGlyph && tone ? (
              activity === 'working' ? (
                <AgentWorkingDots label={activityLabel(activity)} />
              ) : (
                <StatusDot tone={tone.tone} pulse={tone.pulse} label={activityLabel(activity)} />
              )
            ) : null}
            {showRecencyText ? (
              <span
                className="text-meta tabular-nums text-[color:var(--text-subtle)]"
                title={`Idle ${formatRelativeMsAgo(recency!.idleSince!, now)} (${new Date(recency!.idleSince!).toLocaleString()})`}
                aria-label={`Idle ${formatRelativeMsAgo(recency!.idleSince!, now)}`}
              >
                {idleRecencyText}
              </span>
            ) : null}
          </span>
          {/* Hover-and-focus-revealed row actions: keyboard focus surfaces them
              (group-focus-within) so they are reachable and never a focus trap
              on an invisible control. */}
          <span className="pointer-events-none absolute inset-y-0 right-0 inline-flex items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
            <Tooltip content="More actions">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setContextMenu({
                    workspaceId: workspace.id,
                    x: (event.currentTarget as HTMLElement).getBoundingClientRect().right,
                    y: (event.currentTarget as HTMLElement).getBoundingClientRect().bottom,
                  })
                }}
                className={`inline-flex size-control-xs items-center justify-center rounded text-[color:var(--text-disabled)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
                aria-label="Workspace actions"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="icon-xs" aria-hidden="true">
                  <circle cx="3.5" cy="8" r="1.2" />
                  <circle cx="8" cy="8" r="1.2" />
                  <circle cx="12.5" cy="8" r="1.2" />
                </svg>
              </button>
            </Tooltip>
            <Tooltip content="Close workspace">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  handleClose(workspace.id)
                }}
                className={`inline-flex size-control-xs items-center justify-center rounded text-[color:var(--text-disabled)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
                aria-label={`Close ${workspace.name}`}
              >
                <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                  <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </Tooltip>
          </span>
        </span>
      </div>
    )
  }

  // Renders a folder's workspace rows. Rows untouched for 5+ days collapse
  // behind a single "Show N older" disclosure at the bottom of the folder,
  // Cursor-style. Manual order is preserved within both the recent and folded
  // groups. `folderBodyId` lets the folder header's toggle button own an
  // aria-controls pointing at the body it expands/collapses.
  const renderFolderBody = (
    group: FolderGroup,
    visibleWorkspaces: Workspace[],
    folderCollapsed: boolean,
    folderBodyId: string
  ) => {
    // Keep the body element mounted (empty + hidden) while collapsed so the
    // header's aria-controls always resolves to a real node.
    if (folderCollapsed) return <div id={folderBodyId} hidden />

    const { recent, stale } = partitionWorkspacesByRecency(visibleWorkspaces, now, isWorkspacePinned)

    // A disclosure that hides a single row saves no space — the toggle row just
    // replaces the row it would hide — so only fold when there are at least two
    // stale workspaces. A folder with a single workspace is therefore never
    // folded; it just shows in place.
    if (stale.length < 2) {
      return (
        <div id={folderBodyId}>
          {visibleWorkspaces.map((workspace) => renderWorkspaceRow(workspace, group.key))}
        </div>
      )
    }

    const revealed = Math.min(revealedStaleFolders[group.key] ?? 0, stale.length)
    const olderListId = `ws-older-${group.key.replace(/[^a-z0-9]+/giu, '-')}`

    return (
      <div id={folderBodyId}>
        {recent.map((workspace) => renderWorkspaceRow(workspace, group.key))}
        <div
          id={olderListId}
          role="group"
          aria-label={`Older workspaces in ${group.displayName}`}
          hidden={revealed === 0}
        >
          {stale.slice(0, revealed).map((workspace) => renderWorkspaceRow(workspace, group.key))}
        </div>
        <ShowOlderRow
          hiddenTotal={stale.length}
          revealed={revealed}
          controlsId={olderListId}
          onShowMore={() =>
            setRevealedStaleFolders((prev) => ({
              ...prev,
              [group.key]: Math.min((prev[group.key] ?? 0) + FOLD_PAGE_SIZE, stale.length),
            }))
          }
          onShowFewer={() => setRevealedStaleFolders((prev) => ({ ...prev, [group.key]: 0 }))}
        />
      </div>
    )
  }

  return (
    <aside
      ref={sidebarRef}
      aria-label="Workspaces"
      // One of the surface's selection panes: the active workspace row and the
      // active door entry drop to the resting tier while the keyboard is in
      // another pane (assets/index.css, "Selection tiers").
      data-selection-pane="auto"
      // Width is class-driven when collapsed (fixed icon rail) and style-driven
      // when expanded (user-resizable). The width glide is suppressed mid-drag
      // so the rail tracks the pointer instead of lagging the 150ms transition.
      // During a drag the live width comes from dragWidthRef (the drag writes it
      // straight to this element and never to the store), so an unrelated
      // re-render mid-drag keeps the current width instead of the stale store one.
      style={
        sidebarCollapsed
          ? undefined
          : {
              width: clampSidebarWidth(
                isResizingSidebar && dragWidthRef.current !== null
                  ? dragWidthRef.current
                  : sidebarWidth
              ),
              // The persisted width is absolute and this rail is shrink-0, so a
              // window narrower than the width the user last dragged handed the
              // sidebar most of it — 296px of a 390px window, leaving 94px for
              // the whole workspace. The cap is a share of the shell, so the
              // rail gives ground before the surface beside it does. It only
              // binds under a ~1156px window (45% of that is SIDEBAR_MAX_WIDTH);
              // on a narrower one a drag past the cap still records the width the
              // pointer asked for, so widening the window restores it.
              maxWidth: '45%',
            }
      }
      className={`relative flex shrink-0 flex-col bg-[color:var(--bg-canvas)] ${
        isResizingSidebar ? '' : 'transition-[width] duration-150 ease-out motion-reduce:transition-none'
      } ${sidebarCollapsed ? 'hidden' : ''}`}
    >
      {/* Drag the right edge to resize; drag it close to the left to collapse. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
        onDoubleClick={handleResizeDoubleClick}
        className={`group absolute right-0 top-0 z-20 h-full w-1.5 translate-x-1/2 cursor-col-resize ${FOCUS_RING_CLASS}`}
      >
        <span
          aria-hidden="true"
          className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[color:var(--accent-primary)] transition-opacity ${
            isResizingSidebar ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'
          }`}
        />
      </div>
      {/*
       * The sidebar runs to the top of the window, so its own top strip
       * (SidebarChrome) leads: window controls (collapse, search, back/forward,
       * and on win/linux the app menu) that used to sit in the full-width title
       * bar. The Files / Git / Backlog panel switches live in the workspace
       * header over the content, not here.
       */}
      {chromeSlot}
      {/* Drill-in REPLACES the rail (item 1993,
       * `design-system/patterns/context-rail.html`): while a surface is open its
       * rail renders here, in this column, at this width — never as a second
       * navigation column beside it. `hidden` rather than unmounted, because the
       * door row that opened the surface has to still be here for Back to hand
       * focus back to it, and the tree's folds/reveals belong to the operator,
       * not to whether they visited a door in between.
       *
       * Every door declares a rail in every load state (T19), so this column is
       * active for the whole of a door's visit rather than only once the door has
       * content in it. A surface that brought no rail leaves this inactive: it
       * nests no second navigation column, so it has nothing to replace, and
       * emptying the column for it would trade a problem it does not have for a
       * blank rail. */}
      {contextRail}
      <div className={`mx-2 mt-1 flex flex-col gap-1.5 ${contextRailActive ? 'hidden' : ''}`}>
        {/* Instance-level top-nav cluster. Every door carries an explicit `order`
            — the shell's own built-ins (Create=0, Sprints=20, Connectors=30)
            alongside module-contributed doors (Automations=10 and Roadmap=40, from
            the sidebar-nav host contribution point) — and one merged sort renders
            the band deterministically: Create → Automations → Sprints → Connectors
            → Roadmap (D4). A gated door drops out when its module is off without
            disturbing the order of the rest.

            Create cluster: New chat is the primary click (the most common create),
            and the attached "+" opens a menu of everything else; each menu row
            opens the creation hub preselected on that type (the Linear "+" idiom).
            The primary row keeps the tab-extract drop target; Ctrl+T still opens
            the hub on Workspace. */}
        {(
          [
            {
              id: 'create',
              order: 0,
              node: (
                <div className="flex items-stretch gap-px">
                  <Tooltip content="New chat" placement="right" wrapperClassName="flex min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={onNewChat}
                      onDragOver={handleTabDragOverNew}
                      onDragLeave={handleTabDragLeaveNew}
                      onDrop={handleTabDropOnNew}
                      className={`flex h-control-sm min-w-0 flex-1 items-center gap-2 rounded-l-md px-2 text-left text-heading font-medium transition-colors ${FOCUS_RING_CLASS} ${
                        tabDropTarget?.kind === 'new'
                          ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                          : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
                      }`}
                    >
                      <NewChatIcon className="icon-sm pointer-events-none shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {tabDropTarget?.kind === 'new' ? 'Drop to extract' : 'New chat'}
                      </span>
                    </button>
                  </Tooltip>
                  <Tooltip content="New… (Ctrl+T for workspace)" placement="right" wrapperClassName="flex">
                    <button
                      type="button"
                      aria-label="New…"
                      aria-haspopup="menu"
                      onClick={(event) => {
                        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                        setCreateMenu({ x: rect.right, y: rect.bottom })
                      }}
                      className={`flex h-control-sm w-control-xs shrink-0 items-center justify-center rounded-r-md transition-colors ${FOCUS_RING_CLASS} text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]`}
                    >
                      <svg viewBox="0 0 16 16" fill="none" className="icon-sm pointer-events-none shrink-0" aria-hidden="true">
                        <path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                    </button>
                  </Tooltip>
                </div>
              ),
            },
            // Automations (order 10), Sprints (order 20), and Extensions
            // (order 30, the old Connectors slot — MC-1847 B1) are all
            // module-contributed doors in the moduleNavEntries block below —
            // each left this hardcoded list for its own full-page surface, so
            // their built-in buttons retired.
            // Module-contributed doors (Roadmap). Lazy, so wrapped in Suspense; a
            // brief null while its bundle loads is fine for a nav row. The row id
            // is namespaced so a module entry id can never collide with a shell
            // door's React key (a module picks its own entry id freely).
            ...moduleNavEntries.map((entry) => ({
              id: `module:${entry.id}`,
              order: entry.order,
              node: (
                <React.Suspense fallback={null}>
                  <entry.Component collapsed={sidebarCollapsed} />
                </React.Suspense>
              ),
            })),
          ] as Array<{ id: string; order: number; node: React.ReactNode } | null>
        )
          .filter((row): row is { id: string; order: number; node: React.ReactNode } => row !== null)
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
          .map((row) => <React.Fragment key={row.id}>{row.node}</React.Fragment>)}
      </div>

      <div
        aria-hidden="true"
        className={`mx-2 my-2 h-px bg-[color:var(--border-subtle)] ${contextRailActive ? 'hidden' : ''}`}
      />

      {/* Tree: Starred first, then folder groups directly — no "Projects"
          umbrella header; the folder headers are the top level (Cursor-parity).
          Projects and human workspaces only: a sprint run is not a row here
          (item 1767, mockup §1) — the Sprints door lists every run across every
          project, and jumps into a run's terminals from its canvas.

          Alignment grid: every text column starts 36px from the sidebar edge —
          top-nav labels (mx-2 + px-2 + 12px icon + gap-2), section-header
          labels (pl-4 + 14px icon slot + gap-1.5), workspace-row content
          (mx-1.5 + 4px rail + pl-[26px]) and the fold row's chevron
          (mx-1.5 + pl-[30px]). Keep these in step when touching any one. */}
      <nav
        ref={treeRef}
        className={`flex-1 overflow-y-auto pb-2 ${contextRailActive ? 'hidden' : ''}`}
        role="tree"
        onScroll={(event) => {
          treeScrollTopRef.current = event.currentTarget.scrollTop
        }}
      >
        {starredWorkspaces.length > 0 ? (
          <section className="relative pt-1" aria-label="Starred workspaces">
            <button
              type="button"
              onClick={() => setStarredCollapsed((prev) => !prev)}
              aria-expanded={!starredCollapsed}
              aria-controls="ws-starred-body"
              className={`group/folder relative flex h-control-xs w-full cursor-pointer select-none items-center gap-1.5 pl-4 pr-2 text-left text-[color:var(--text-muted)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
            >
              {/* One icon slot, Cursor-style: the star at rest, the collapse
                  chevron swapped in on hover — no dedicated chevron column, so
                  child rows don't have to indent past it. */}
              <span className="relative flex size-icon-sm shrink-0 items-center justify-center">
                <StarGlyph
                  filled
                  className="icon-sm shrink-0 text-[color:var(--tone-warn)] transition-opacity group-hover/folder:opacity-0"
                />
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                  className={`icon-xs absolute inset-0 m-auto text-[color:var(--text-muted)] opacity-0 transition-[opacity,transform] group-hover/folder:opacity-100 ${
                    starredCollapsed ? '-rotate-90' : ''
                  }`}
                >
                  <path d="M5 6L8 9L11 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="min-w-0 flex-1 truncate text-heading font-semibold text-[color:var(--text-strong)]">
                Starred
              </span>
            </button>
            <div id="ws-starred-body" hidden={starredCollapsed}>
              {!starredCollapsed
                ? starredWorkspaces.map((workspace) =>
                    renderWorkspaceRow(workspace, folderKey(workspace.folderPath), { keyPrefix: 'starred-' })
                  )
                : null}
            </div>
          </section>
        ) : null}
        {groups.map((group) => {
          const collapsed = collapsedFolders[group.key] === true
          // Each folder's rows are ordered by how recently each was worked on,
          // same as the Starred section — not by live status, so opening a row
          // never moves it. The stale-fold below still partitions by the 5-day
          // threshold; this only sets the order within the recent and folded
          // groups.
          const visibleWorkspaces = sortWorkspacesByActivity(group.workspaces)
          const folderBodyId = `ws-folder-body-${group.key.replace(/[^a-z0-9]+/giu, '-')}`
          const dropMark =
            dropIndicator?.kind === 'folder' && dropIndicator.targetKey === group.key
              ? dropIndicator.position
              : null
          return (
            <section key={group.key} className="relative pt-1">
              {/* The header container carries drag + context-menu; the disclosure
                  itself is a real button (aria-expanded / aria-controls) so the
                  folder is keyboard-operable, with the overflow control as a
                  sibling rather than a nested interactive element. */}
              <header
                draggable
                onDragStart={(event) => handleFolderDragStart(event, group.key)}
                onDragOver={(event) => handleFolderDragOver(event, group.key)}
                onDrop={(event) => handleFolderDrop(event, group.key)}
                onDragEnd={handleDragEnd}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setFolderMenu({ folderKey: group.key, x: event.clientX, y: event.clientY })
                }}
                className={`group/folder relative flex h-control-xs select-none items-center gap-1.5 pr-2 text-[color:var(--text-muted)] ${
                  group.missing ? 'text-[color:var(--tone-warn)]' : ''
                }`}
              >
                {dropMark === 'before' ? (
                  <span aria-hidden="true" className="absolute inset-x-1 top-[-1px] h-[2px] rounded bg-[color:var(--accent-primary)]" />
                ) : null}
                {dropMark === 'after' ? (
                  <span aria-hidden="true" className="absolute inset-x-1 bottom-[-1px] h-[2px] rounded bg-[color:var(--accent-primary)]" />
                ) : null}
                <button
                  type="button"
                  onClick={() =>
                    setCollapsedFolders((prev) => ({ ...prev, [group.key]: !collapsed }))
                  }
                  aria-expanded={!collapsed}
                  aria-controls={folderBodyId}
                  title={group.fullPath ?? 'Workspaces with no folder'}
                  className={`flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 pl-4 text-left transition-colors hover:text-[color:var(--text-default)] ${
                    group.missing ? 'hover:text-[color:var(--tone-warn)]' : ''
                  } ${FOCUS_RING_CLASS}`}
                >
                  {/* One icon slot, Cursor-style: the folder glyph at rest, the
                      collapse chevron swapped in on hover. */}
                  <span className="relative flex size-icon-sm shrink-0 items-center justify-center">
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                      className="icon-sm shrink-0 transition-opacity group-hover/folder:opacity-0"
                    >
                      <path
                        d="M2 4.5C2 3.67 2.67 3 3.5 3H6.5L8 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z"
                        stroke="currentColor"
                        strokeWidth="1.4"
                      />
                    </svg>
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                      className={`icon-xs absolute inset-0 m-auto text-[color:var(--text-muted)] opacity-0 transition-[opacity,transform] group-hover/folder:opacity-100 ${
                        collapsed ? '-rotate-90' : ''
                      }`}
                    >
                      <path d="M5 6L8 9L11 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-heading font-semibold text-[color:var(--text-strong)]">
                    {group.displayName}
                  </span>
                </button>
                {group.missing ? (
                  <span className="inline-flex items-center gap-1.5 text-meta font-medium text-[color:var(--tone-warn)]">
                    <StatusDot tone="warn" label="Folder missing" />
                    Missing
                  </span>
                ) : null}
                <Tooltip content="Folder actions">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      setFolderMenu({
                        folderKey: group.key,
                        x: (event.currentTarget as HTMLElement).getBoundingClientRect().right,
                        y: (event.currentTarget as HTMLElement).getBoundingClientRect().bottom,
                      })
                    }}
                    className={`ml-1 inline-flex size-control-xs items-center justify-center rounded text-[color:var(--text-disabled)] opacity-0 transition-opacity hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] group-hover/folder:opacity-100 focus-visible:opacity-100 ${FOCUS_RING_CLASS}`}
                    aria-label={`Folder actions: ${group.displayName}`}
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="icon-xs" aria-hidden="true">
                      <circle cx="3.5" cy="8" r="1.2" />
                      <circle cx="8" cy="8" r="1.2" />
                      <circle cx="12.5" cy="8" r="1.2" />
                    </svg>
                  </button>
                </Tooltip>
              </header>
              {renderFolderBody(group, visibleWorkspaces, collapsed, folderBodyId)}
            </section>
          )
        })}
      </nav>

      {/* Sidebar-bottom account + Settings, relocated from WorkspaceTopBar
          (Cursor-parity). Pinned to the bottom because the <nav> above is
          flex-1; this is where the Automations rail used to sit (now a top-nav
          entry). */}
      {/* The drilled-in rail's bottom row is Back, so the account cluster steps
          aside with the rest of this column's content — one rail, one thing
          pinned at its foot. It returns with the rail. */}
      <div className={`flex flex-col ${contextRailActive ? 'hidden' : ''}`}>
      <SidebarAccountBar
        collapsed={sidebarCollapsed}
        authState={authState}
        authMessage={authMessage}
        accountOpen={accountOpen}
        setAccountOpen={setAccountOpen}
        startLogin={startLogin}
        refreshAuthState={refreshAuthState}
        logout={logout}
        openSettings={openSettings}
        settingsOpen={settingsOpen}
      />
      </div>

      {/* The "+" create menu: one row per creatable type, mirroring the
          creation hub rail's list and order (buildModeModels). Chat routes to
          the dedicated New Chat panel; everything else opens the hub
          preselected on that type. */}
      {createMenu ? (
        <PointerPopover
          x={createMenu.x}
          y={createMenu.y}
          ariaLabel="Create"
          onClose={() => setCreateMenu(null)}
        >
          <div className="min-w-[200px] max-w-[280px] py-1">
            {createMenuModels.map((model) => {
              const Icon = model.icon
              return (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => {
                    setCreateMenu(null)
                    if (model.id === 'chat') onNewChat()
                    else if (model.id === 'standard') onNewWorkspace()
                    else onNewWorkspaceMode(model.id)
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-heading text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
                >
                  <Icon className="icon-xs pointer-events-none shrink-0 text-[color:var(--text-subtle)]" />
                  <span className="min-w-0 flex-1 truncate">{`New ${model.label.toLowerCase()}`}</span>
                  {model.id === 'standard' ? (
                    <kbd className="shrink-0 font-mono text-micro text-[color:var(--text-disabled)]">Ctrl+T</kbd>
                  ) : null}
                </button>
              )
            })}
          </div>
        </PointerPopover>
      ) : null}

      {/* Context menu (workspace row) */}
      {contextMenu ? (
        <WorkspaceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          workspace={workspaceById.get(contextMenu.workspaceId) ?? null}
          isDetachedWindow={isDetachedWindow}
          onClose={() => setContextMenu(null)}
          onSelect={(action) => {
            const workspace = workspaceById.get(contextMenu.workspaceId)
            if (!workspace) {
              setContextMenu(null)
              return
            }
            if (action === 'open') {
              onSelectWorkspace(workspace.id)
              setContextMenu(null)
              return
            }
            if (action === 'rename') {
              startRename(workspace)
              setContextMenu(null)
              return
            }
            if (action === 'new-chat' && workspace.folderPath && !workspace.folderMissing) {
              onNewChatInFolder(workspace.folderPath)
              setContextMenu(null)
              return
            }
            if (action === 'new-workspace' && workspace.folderPath && !workspace.folderMissing) {
              onNewWorkspaceInFolder(workspace.folderPath)
              setContextMenu(null)
              return
            }
            if (action === 'reveal' && workspace.folderPath) {
              onRevealFolder(workspace.folderPath)
              setContextMenu(null)
              return
            }
            if (action === 'move-to-new-window') {
              onMoveWorkspaceToNewWindow(workspace.id)
              setContextMenu(null)
              return
            }
            if (action === 'move-to-main-window') {
              onMoveWorkspaceToMainWindow(workspace.id)
              setContextMenu(null)
              return
            }
            if (action === 'close') {
              handleClose(workspace.id)
              setContextMenu(null)
              return
            }
            if (action === 'delete') {
              setDeleteTypedName('')
              setConfirmDelete(workspace.id)
              setContextMenu(null)
              return
            }
            if (action === 'cancel-sprint') {
              setConfirmCancelSprint(workspace.id)
              setContextMenu(null)
              return
            }
            if (action === 'toggle-star') {
              setWorkspaceHighlight(workspace.id, {
                starred: !isStarred(workspace.highlight),
              })
              return
            }
            if (action === 'clear-color') {
              if (isStarred(workspace.highlight)) {
                setWorkspaceHighlight(workspace.id, { color: null })
              } else {
                clearWorkspaceHighlight(workspace.id)
              }
              return
            }
          }}
          onPickColor={(color) => {
            setWorkspaceHighlight(contextMenu.workspaceId, { color })
          }}
        />
      ) : null}

      {/* Folder context menu */}
      {folderMenu ? (
        <FolderContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          group={groups.find((g) => g.key === folderMenu.folderKey) ?? null}
          onClose={() => setFolderMenu(null)}
          onSelect={(action) => {
            const group = groups.find((g) => g.key === folderMenu.folderKey)
            setFolderMenu(null)
            if (!group) return
            if (action === 'new-chat' && group.fullPath && !group.missing) {
              onNewChatInFolder(group.fullPath)
            }
            if (action === 'new-workspace' && group.fullPath && !group.missing) {
              onNewWorkspaceInFolder(group.fullPath)
            }
            if (action === 'reveal' && group.fullPath) onRevealFolder(group.fullPath)
            if (action === 'forget' && group.fullPath) setConfirmForget(group.fullPath)
          }}
        />
      ) : null}

      {/* Close-confirm popover (modal-style for safety) */}
      <Modal
        open={confirmClose !== null}
        onClose={() => setConfirmClose(null)}
        labelledBy="ws-close-title"
        width={420}
      >
        {confirmClose ? (
          (() => {
            const workspace = workspaceById.get(confirmClose)
            const activity = activityByWorkspaceId[confirmClose] ?? 'idle'
            return (
              <>
                <ModalHeader
                  titleId="ws-close-title"
                  title={`Close “${workspace?.name ?? 'workspace'}”?`}
                  subtitle={
                    activity === 'needs-input'
                      ? 'A task is waiting for input. Closing will lose that prompt.'
                      : 'Running agents will be stopped. Workspace files on disk are kept.'
                  }
                  onClose={() => setConfirmClose(null)}
                />
                <ModalFooter>
                  <ModalButton onClick={() => setConfirmClose(null)}>Cancel</ModalButton>
                  <ModalButton
                    variant="danger"
                    onClick={() => {
                      const id = confirmClose
                      setConfirmClose(null)
                      if (id) onCloseWorkspace(id)
                    }}
                  >
                    Close workspace
                  </ModalButton>
                </ModalFooter>
              </>
            )
          })()
        ) : null}
      </Modal>

      {/* Cancel-sprint confirm */}
      <Modal
        open={confirmCancelSprint !== null}
        onClose={() => setConfirmCancelSprint(null)}
        labelledBy="ws-cancel-sprint-title"
        width={440}
      >
        {confirmCancelSprint ? (
          (() => {
            const workspace = workspaceById.get(confirmCancelSprint)
            return (
              <>
                <ModalHeader
                  titleId="ws-cancel-sprint-title"
                  title={`Cancel sprint “${workspace?.name ?? 'workspace'}”?`}
                  subtitle="Running agents stop and every unfinished task is marked canceled. Finished work and the run branch are kept. This cannot be undone."
                  onClose={() => setConfirmCancelSprint(null)}
                />
                <ModalFooter>
                  <ModalButton onClick={() => setConfirmCancelSprint(null)} disabled={cancelSprintBusy}>
                    Keep running
                  </ModalButton>
                  <ModalButton
                    variant="danger"
                    disabled={cancelSprintBusy}
                    onClick={() => {
                      const id = confirmCancelSprint
                      setConfirmCancelSprint(null)
                      if (id) void cancelSprintForWorkspace(id)
                    }}
                  >
                    Cancel sprint
                  </ModalButton>
                </ModalFooter>
              </>
            )
          })()
        ) : null}
      </Modal>

      {/* Forget folder confirm */}
      <Modal
        open={confirmForget !== null}
        onClose={() => setConfirmForget(null)}
        labelledBy="ws-forget-title"
        width={460}
      >
        {confirmForget ? (
          (() => {
            const group = groups.find((g) => g.fullPath === confirmForget)
            const count = group?.workspaces.length ?? 0
            return (
              <>
                <ModalHeader
                  titleId="ws-forget-title"
                  title={`Forget folder “${folderDisplayName(confirmForget)}”?`}
                  subtitle={`Closes ${count} workspace${count === 1 ? '' : 's'} under this folder and removes the folder from recents. Files on disk are kept.`}
                  onClose={() => setConfirmForget(null)}
                />
                <ModalFooter>
                  <ModalButton onClick={() => setConfirmForget(null)}>Cancel</ModalButton>
                  <ModalButton
                    variant="danger"
                    onClick={() => {
                      const path = confirmForget
                      setConfirmForget(null)
                      if (path) onForgetFolder(path)
                    }}
                  >
                    Forget folder
                  </ModalButton>
                </ModalFooter>
              </>
            )
          })()
        ) : null}
      </Modal>

      {/* Delete with on-disk state (sprintengine) */}
      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        labelledBy="ws-delete-title"
        width={500}
      >
        {confirmDelete
          ? (() => {
              const workspace = workspaceById.get(confirmDelete)
              if (!workspace) return null
              const dirPath =
                workspace.mode === 'sprintengine'
                  ? workspace.sprintEngineContext?.teamDirectoryPath ?? null
                  : null
              const typedOk = deleteTypedName.trim() === workspace.name.trim()
              return (
                <>
                  <ModalHeader
                    titleId="ws-delete-title"
                    title={`Delete workspace “${workspace.name}”?`}
                    subtitle={`This stops running agents and removes the on-disk state directory${
                      dirPath ? ` at ${dirPath}` : ''
                    }. This cannot be undone.`}
                    onClose={() => setConfirmDelete(null)}
                  />
                  <ModalBody>
                    <Field label="Type the workspace name to confirm" htmlFor="ws-delete-confirm-name">
                      <Input
                        autoFocus
                        value={deleteTypedName}
                        onChange={(event) => setDeleteTypedName(event.target.value)}
                        placeholder={workspace.name}
                      />
                    </Field>
                  </ModalBody>
                  <ModalFooter>
                    <ModalButton onClick={() => setConfirmDelete(null)}>Cancel</ModalButton>
                    <ModalButton
                      variant="danger"
                      disabled={!typedOk}
                      onClick={() => {
                        const id = confirmDelete
                        setConfirmDelete(null)
                        setDeleteTypedName('')
                        if (id) void onDeleteWorkspaceWithState(id)
                      }}
                    >
                      Delete workspace
                    </ModalButton>
                  </ModalFooter>
                </>
              )
            })()
          : null}
      </Modal>
    </aside>
  )
}

type ContextMenuAction =
  | 'open'
  | 'rename'
  | 'new-chat'
  | 'new-workspace'
  | 'reveal'
  | 'move-to-new-window'
  | 'move-to-main-window'
  | 'close'
  | 'delete'
  | 'cancel-sprint'
  | 'toggle-star'
  | 'clear-color'

// Workspace-row context menu. Generic menu chrome (surface, clamped
// positioning, items, dividers, swatch row, dismissal, focus handling) lives
// in the ui/ContextMenu primitive; only the sidebar's actions stay here.
function WorkspaceContextMenu({
  x,
  y,
  workspace,
  isDetachedWindow,
  onClose,
  onSelect,
  onPickColor,
}: {
  x: number
  y: number
  workspace: Workspace | null
  isDetachedWindow: boolean
  onClose: () => void
  onSelect: (action: ContextMenuAction) => void
  onPickColor: (color: HighlightColor) => void
}) {
  if (!workspace) return null
  const showDelete = workspaceHasOnDiskState(workspace)
  const showCancelSprint = isCancelableSprintEngineWorkspace(workspace)
  const folderPathExists = Boolean(workspace.folderPath) && !workspace.folderMissing
  const starred = isStarred(workspace.highlight)
  const currentColor = workspace.highlight?.color ?? null

  return (
    <ContextMenu
      x={x}
      y={y}
      ariaLabel={`Workspace actions: ${workspace.name}`}
      onClose={onClose}
      surfaceClassName="min-w-[240px]"
    >
      <MenuItem onClick={() => onSelect('open')}>Open</MenuItem>
      <MenuItem onClick={() => onSelect('rename')} shortcut="F2">
        Rename
      </MenuItem>
      {folderPathExists ? (
        <MenuItem onClick={() => onSelect('new-chat')}>New chat in project</MenuItem>
      ) : null}
      {folderPathExists ? (
        <MenuItem onClick={() => onSelect('new-workspace')}>New workspace in project</MenuItem>
      ) : null}
      {folderPathExists ? <MenuItem onClick={() => onSelect('reveal')}>Reveal folder</MenuItem> : null}
      {isDetachedWindow ? (
        <MenuItem onClick={() => onSelect('move-to-main-window')}>Move to Main Window</MenuItem>
      ) : (
        <MenuItem onClick={() => onSelect('move-to-new-window')}>Move to New Window</MenuItem>
      )}
      <MenuDivider />
      <MenuItem
        checked={starred}
        onClick={() => onSelect('toggle-star')}
        icon={
          <StarGlyph
            filled={starred}
            stroked
            className={`icon-sm shrink-0 ${starred ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-disabled)]'}`}
          />
        }
      >
        {starred ? 'Unstar' : 'Star'}
      </MenuItem>
      <MenuSwatchRow
        label="Highlight color"
        value={currentColor}
        onPick={onPickColor}
        onClear={() => onSelect('clear-color')}
      />
      <MenuDivider />
      {showCancelSprint ? (
        <MenuItem variant="danger" onClick={() => onSelect('cancel-sprint')}>
          Cancel sprint…
        </MenuItem>
      ) : null}
      <MenuItem onClick={() => onSelect('close')}>Close workspace</MenuItem>
      {showDelete ? (
        <MenuItem variant="danger" onClick={() => onSelect('delete')}>
          Delete workspace…
        </MenuItem>
      ) : null}
    </ContextMenu>
  )
}

type FolderMenuAction = 'new-chat' | 'new-workspace' | 'reveal' | 'forget'

function FolderContextMenu({
  x,
  y,
  group,
  onClose,
  onSelect,
}: {
  x: number
  y: number
  group: FolderGroup | null
  onClose: () => void
  onSelect: (action: FolderMenuAction) => void
}) {
  if (!group) return null
  const canReveal = Boolean(group.fullPath) && !group.missing
  const canForget = Boolean(group.fullPath)
  const canCreateWorkspace = Boolean(group.fullPath) && !group.missing

  return (
    <ContextMenu
      x={x}
      y={y}
      ariaLabel={`Folder actions: ${group.displayName}`}
      onClose={onClose}
      surfaceClassName="min-w-[220px]"
    >
      {canCreateWorkspace ? (
        <MenuItem onClick={() => onSelect('new-chat')}>New chat in project</MenuItem>
      ) : null}
      {canCreateWorkspace ? (
        <MenuItem onClick={() => onSelect('new-workspace')}>New workspace in project</MenuItem>
      ) : null}
      {canReveal ? <MenuItem onClick={() => onSelect('reveal')}>Reveal folder</MenuItem> : null}
      {canCreateWorkspace && canForget ? <MenuDivider /> : null}
      {canForget ? (
        <MenuItem variant="danger" onClick={() => onSelect('forget')}>
          Forget folder…
        </MenuItem>
      ) : null}
    </ContextMenu>
  )
}
