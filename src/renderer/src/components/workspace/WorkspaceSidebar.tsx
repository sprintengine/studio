import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  NewChatIcon,
  SprintEngineMarkIcon,
  SprintEngineWorkspaceTypeIcon,
  WorkspaceTypeIcon,
  resolveEnabledWorkspaceType,
} from '../AppIcons'
import { buildModeModels } from './newWorkspace/modeModels'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import { SidebarNavButton } from './SidebarNavButton'
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
import { deriveWorkspaceRunGlyph, workspaceHasRunGlyphProvider } from '../../utils/workspaceRunGlyph'
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
  border: string
  bg: string
  text: string
  shadow: string
  collapsedShadow: string
  chip: string
  glyph: string
}

// Mode identity now reads through the canonical tool tokens: the colored
// 4 px left rail and the icon glyph carry the mode signal, while the active
// row body sits on the brighter `--bg-selected` surface — the same canonical
// selection fill used elsewhere (notifications, file/artifact selection) — so
// the selected row clears the hover `--bg-surface-raised` fill by a full step.
// The previous per-mode blended backgrounds and decorative inset+glow halos
// stay dropped in favour of a hairline + identity-rail composition that matches
// the audit's one-accent restraint.
const modeAccents: Record<Workspace['mode'], RowAccent> = {
  sprintengine: {
    border: 'border-l-[color:var(--tool-sprintengine)]',
    bg: 'bg-[color:var(--bg-selected)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    collapsedShadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    chip: 'bg-[color:var(--bg-hover)]',
    glyph: 'text-[color:var(--tool-sprintengine)]',
  },
  switchboard: {
    border: 'border-l-[color:var(--tool-switchboard)]',
    bg: 'bg-[color:var(--bg-selected)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    collapsedShadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    chip: 'bg-[color:var(--bg-hover)]',
    glyph: 'text-[color:var(--tool-switchboard)]',
  },
  multiloop: {
    border: 'border-l-[color:var(--tool-multiloop)]',
    bg: 'bg-[color:var(--bg-selected)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    collapsedShadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    chip: 'bg-[color:var(--bg-hover)]',
    glyph: 'text-[color:var(--tool-multiloop)]',
  },
  'guided-brief': {
    border: 'border-l-[color:var(--accent-primary)]',
    bg: 'bg-[color:var(--bg-selected)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    collapsedShadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    chip: 'bg-[color:var(--bg-hover)]',
    glyph: 'text-[color:var(--accent-primary)]',
  },
  // Automations host carries the same primary-accent identity as its registered
  // accentToken (--accent-primary) so its rows read distinctly from the muted
  // `standard` rows that dominate the list, instead of falling through to it.
  'automations-host': {
    border: 'border-l-[color:var(--accent-primary)]',
    bg: 'bg-[color:var(--bg-selected)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    collapsedShadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    chip: 'bg-[color:var(--bg-hover)]',
    glyph: 'text-[color:var(--accent-primary)]',
  },
  standard: {
    border: 'border-l-[color:var(--border-strong)]',
    bg: 'bg-[color:var(--bg-selected)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    collapsedShadow: 'shadow-[inset_0_0_0_1px_var(--border-strong)]',
    chip: 'bg-[color:var(--bg-hover)]',
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
      border: swatch.border,
      bg: swatch.bg,
      text: swatch.text,
      shadow: swatch.shadow,
      collapsedShadow: swatch.collapsedShadow,
      chip: swatch.chip,
      glyph: `text-[${swatch.hex}]`,
    }
  }
  const effectiveMode: Workspace['mode'] = resolveEnabledWorkspaceType(workspace.mode, moduleOverrides)
    ? workspace.mode
    : 'standard'
  return modeAccents[effectiveMode] ?? modeAccents.standard
}

function activeRowClass(workspace: Workspace, moduleOverrides: ModuleEnablementOverrides): string {
  const accent = rowAccent(workspace, moduleOverrides)
  return `border-l-[4px] ${accent.border} ${accent.bg} ${accent.text} ${accent.shadow}`
}

function collapsedActiveRowClass(workspace: Workspace, moduleOverrides: ModuleEnablementOverrides): string {
  const accent = rowAccent(workspace, moduleOverrides)
  return `${accent.bg} ${accent.text} ${accent.collapsedShadow}`
}

// Class fragment applied to inactive rows that have a highlight color set, so
// the user spots their highlighted workspaces at a glance even when not active.
// The colored left rail plus a dimmed full-width tint of the same hue — the
// quiet half of the dim/bright pair; selecting the row swaps to the brighter
// `bg` fill in `activeRowClass`.
function inactiveHighlightClass(workspace: Workspace): string {
  if (!hasHighlightOverride(workspace.highlight)) return ''
  const swatch = getHighlightSwatch(workspace.highlight!.color!)
  return `border-l-[4px] ${swatch.border} ${swatch.dimBg}`
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
  if (workspace.mode === 'multiloop') return Boolean(workspace.multiloopContext?.loopDirectoryPath)
  return false
}

// A Cancel-sprint action is offered only for a live Sprint Engine run: the
// right mode, a resolved run file to target, and not already in a terminal
// state. Terminality is read from whichever signal is hydrated — the projection
// flags when present, else the persisted automation runtime state — so a
// canceled/completed run in the sidebar never re-offers Cancel.
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
    'flex h-[26px] cursor-pointer select-none items-center gap-1.5 rounded-md text-[12px] text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]'
  return (
    <div className="mx-1.5 my-[1px] flex items-center gap-1">
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
  // The Connectors nav entry opens the store-level Connectors surface (mounted
  // by WorkspaceManager) and reads its open state to carry aria-current.
  const openConnectorsSurface = useWorkspaceStore((s) => s.openConnectorsSurface)
  const connectorsSurfaceOpen = useWorkspaceStore((s) => s.connectorsSurface.open)
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
  // The Sprints nav entry toggles the global Sprint Engines aside — the
  // existing "all sprints across every project" survey panel mounted by
  // WorkspaceManager — rather than a bespoke surface. Gated on the module.
  const sprintEnginesAsideOpen = useWorkspaceStore((s) => s.sprintEnginesAsideOpen)
  const setSprintEnginesAsideOpen = useWorkspaceStore((s) => s.setSprintEnginesAsideOpen)
  const sprintEngineEnabled = useWorkspaceStore((s) =>
    selectModuleEnabled(s.appSettings.modules, 'sprint-engine')
  )
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

  // Rail-hidden workspaces (the background Automations host) stay in the store
  // and in window assignments but never render as rail rows. Every presentation
  // path below — folder groups, starred — derives from this list, while
  // drag-reorder still stitches against the full `workspaces` array so the host
  // keeps its place in the persisted order. Cross-workspace search now lives in
  // the global-search palette (T6), not a sidebar box.
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
      !sidebarCollapsed
      && !runGlyph
      && activity === 'idle'
      && !!recency
      && !recency.hasRunning
      && !!idleRecencyText
    // Collapsed rows keep the corner-dot idiom (a 16px glyph doesn't fit as an
    // overlay on the 20px icon); it derives from the same rollup so the two
    // presentations agree. Only the attention states earn the corner dot.
    const collapsedDot = runGlyph
      ? runGlyph.state === 'needs_input'
        ? { tone: 'warn' as Tone, pulse: true }
        : runGlyph.state === 'failed'
          ? { tone: 'error' as Tone, pulse: false }
          : null
      : // A run-glyph-owning row (a Sprint Engine run) with no glyph is genuinely
        // resting: its provider already decided "no run signal" from sprint state,
        // so the terminal-derived tone must not relight it. Provider-less rows keep
        // the terminal dot idiom.
        workspaceHasRunGlyphProvider(workspace)
        ? null
        : tone
    const folderMissing = workspace.folderMissing === true
    const starred = isStarred(workspace.highlight)
    // "Hot": at least one resident (live-PTY) agent — instant to switch into.
    // Bolded below so suspended/exited workspaces read as the quieter state.
    const resident = residentWorkspaceIds.has(workspace.id)
    const highlighted = hasHighlightOverride(workspace.highlight)
    const accent = rowAccent(workspace, moduleOverrides)
    const dropMark =
      dropIndicator?.kind === 'workspace' && dropIndicator.targetId === workspace.id
        ? dropIndicator.position
        : null
    const isTabDropTarget =
      tabDropTarget?.kind === 'workspace' && tabDropTarget.id === workspace.id
    const rowKey = `${options?.keyPrefix ?? ''}${workspace.id}`
    // Collapsed rows hide the name text, so it has to live somewhere reachable:
    // as the row's accessible name (aria-label) and as the hover tooltip below.
    const collapsedLabel = `${workspace.name}${
      workspace.folderPath ? ` · ${folderDisplayName(workspace.folderPath)}` : ''
    }`

    const row = (
      <div
        key={rowKey}
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
        aria-label={sidebarCollapsed ? collapsedLabel : undefined}
        className={`group relative mx-1.5 my-[1px] flex h-[30px] cursor-pointer select-none items-center gap-2 rounded-md text-[13px] transition-colors ${
          sidebarCollapsed
            ? 'justify-center px-0'
            : 'border-l-[4px] border-l-transparent pl-[26px] pr-1.5'
        } ${
          active
            ? sidebarCollapsed
              ? collapsedActiveRowClass(workspace, moduleOverrides)
              : activeRowClass(workspace, moduleOverrides)
            : highlighted && !sidebarCollapsed
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

        {/* Expanded rows drop the workspace-type icon chip so the title starts
            flush with the row's content edge — in the narrow sidebar the chip
            cost ~28px that the name needs more. Mode identity survives in the
            colored left rail / accent (active + highlighted rows) and the
            trailing run glyph; the collapsed icon rail keeps the glyph because
            there it IS the row. Sprint rows are the one exception: they carry
            the small sprint glyph inline (below) so a sprint reads as a sprint
            at a glance. */}
        {sidebarCollapsed ? (
          <span
            className={`flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-md transition-colors ${
              active || highlighted ? accent.chip : ''
            }`}
          >
            <WorkspaceTypeIcon
              mode={workspace.mode}
              moduleOverrides={moduleOverrides}
              className={`h-4 w-4 ${accent.glyph}`}
            />
          </span>
        ) : null}

        {!sidebarCollapsed && (
          <>
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
                className="min-w-0 flex-1 rounded border border-[color:var(--border-default)] bg-[color:var(--bg-app)] px-1.5 py-0 text-[13px] text-[color:var(--text-strong)] focus:outline-none"
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
              <span className="inline-flex items-center gap-1 transition-opacity group-hover:opacity-0">
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
                    className="text-[10px] tabular-nums text-[color:var(--text-subtle)]"
                    title={`Idle ${formatRelativeMsAgo(recency!.idleSince!, now)} (${new Date(recency!.idleSince!).toLocaleString()})`}
                    aria-label={`Idle ${formatRelativeMsAgo(recency!.idleSince!, now)}`}
                  >
                    {idleRecencyText}
                  </span>
                ) : null}
              </span>
              <span className="pointer-events-none absolute inset-y-0 right-0 inline-flex items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
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
                    className="inline-flex h-5 w-5 items-center justify-center rounded text-[color:var(--text-disabled)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]"
                    aria-label="Workspace actions"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="icon-xs">
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
                    className="inline-flex h-5 w-5 items-center justify-center rounded text-[color:var(--text-disabled)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]"
                    aria-label={`Close ${workspace.name}`}
                  >
                    <svg viewBox="0 0 16 16" fill="none" className="icon-xs">
                      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  </button>
                </Tooltip>
              </span>
            </span>
          </>
        )}

        {sidebarCollapsed && collapsedDot ? (
          <span className="absolute right-1 top-1">
            <StatusDot tone={collapsedDot.tone} pulse={collapsedDot.pulse} />
          </span>
        ) : null}

        {sidebarCollapsed && starred ? (
          <span
            className="absolute right-0.5 bottom-0.5 text-[8px] leading-none text-[color:var(--tone-warn)]"
            aria-hidden="true"
          >
            ★
          </span>
        ) : null}

        {sidebarCollapsed && highlighted && !active ? (
          <span
            className={`absolute inset-y-1 left-0 w-[2px] rounded-r ${getHighlightSwatch(workspace.highlight!.color!).border.replace('border-l-', 'bg-')}`}
            aria-hidden="true"
          />
        ) : null}
      </div>
    )

    // Collapsed: the name isn't visible inline, so a styled tooltip surfaces it
    // on hover. `right` keeps it clear of the narrow rail; the presentation-role
    // wrapper keeps the tree → treeitem relationship intact.
    if (sidebarCollapsed) {
      return (
        <Tooltip
          key={rowKey}
          content={collapsedLabel}
          placement="right"
          wrapperClassName="block"
          wrapperRole="presentation"
        >
          {row}
        </Tooltip>
      )
    }

    return row
  }

  // Renders a folder's workspace rows. In the collapsed icon rail every row is
  // shown (no fold — it is already a compact strip). In the expanded sidebar,
  // rows untouched for 5+ days collapse behind a single "Show N older"
  // disclosure at the bottom of the folder, Cursor-style. Manual order is
  // preserved within both the recent and folded groups.
  const renderFolderBody = (
    group: FolderGroup,
    visibleWorkspaces: Workspace[],
    folderCollapsed: boolean
  ) => {
    if (folderCollapsed && !sidebarCollapsed) return null
    if (sidebarCollapsed) {
      return (
        <div className="border-b border-[color:var(--bg-hover)] pb-1.5 last:border-b-0">
          {visibleWorkspaces.map((workspace) => renderWorkspaceRow(workspace, group.key))}
        </div>
      )
    }

    const { recent, stale } = partitionWorkspacesByRecency(visibleWorkspaces, now, isWorkspacePinned)

    // A disclosure that hides a single row saves no space — the toggle row just
    // replaces the row it would hide — so only fold when there are at least two
    // stale workspaces. A folder with a single workspace is therefore never
    // folded; it just shows in place.
    if (stale.length < 2) {
      return (
        <div>
          {visibleWorkspaces.map((workspace) => renderWorkspaceRow(workspace, group.key))}
        </div>
      )
    }

    const revealed = Math.min(revealedStaleFolders[group.key] ?? 0, stale.length)
    const olderListId = `ws-older-${group.key.replace(/[^a-z0-9]+/giu, '-')}`

    return (
      <div>
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
            }
      }
      className={`relative flex shrink-0 flex-col bg-[color:var(--bg-app)] ${
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
        className={`group absolute right-0 top-0 z-20 h-full w-1.5 translate-x-1/2 cursor-col-resize focus:outline-none ${FOCUS_RING_CLASS}`}
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
      <div className={`mt-1 flex flex-col gap-1.5 ${sidebarCollapsed ? 'mx-1.5' : 'mx-2'}`}>
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
              node: sidebarCollapsed ? (
                <>
                  <SidebarNavButton
                    collapsed={sidebarCollapsed}
                    dropActive={tabDropTarget?.kind === 'new'}
                    icon={<NewChatIcon className="icon-xs pointer-events-none shrink-0" />}
                    label={tabDropTarget?.kind === 'new' ? 'Drop to extract' : 'New chat'}
                    ariaLabel="New chat"
                    tooltip="New chat"
                    onClick={onNewChat}
                    onDragOver={handleTabDragOverNew}
                    onDragLeave={handleTabDragLeaveNew}
                    onDrop={handleTabDropOnNew}
                  />
                  <SidebarNavButton
                    collapsed={sidebarCollapsed}
                    icon={
                      <svg viewBox="0 0 16 16" fill="none" className="icon-xs pointer-events-none shrink-0">
                        <path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                    }
                    label="New…"
                    ariaLabel="New…"
                    tooltip="New… (Ctrl+T for workspace)"
                    onClick={(event) => {
                      // Anchor to the button, not the pointer — a keyboard-activated
                      // click reports clientX/Y of 0,0.
                      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                      setCreateMenu({ x: rect.right, y: rect.top })
                    }}
                  />
                </>
              ) : (
                <div className="flex items-stretch gap-px">
                  <Tooltip content="New chat" placement="right" wrapperClassName="flex min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={onNewChat}
                      onDragOver={handleTabDragOverNew}
                      onDragLeave={handleTabDragLeaveNew}
                      onDrop={handleTabDropOnNew}
                      className={`flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-l-md px-2 text-left text-[12px] font-medium transition-colors ${FOCUS_RING_CLASS} ${
                        tabDropTarget?.kind === 'new'
                          ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                          : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
                      }`}
                    >
                      <NewChatIcon className="icon-xs pointer-events-none shrink-0" />
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
                      className={`flex h-[30px] w-[26px] shrink-0 items-center justify-center rounded-r-md transition-colors ${FOCUS_RING_CLASS} text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]`}
                    >
                      <svg viewBox="0 0 16 16" fill="none" className="icon-xs pointer-events-none shrink-0">
                        <path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                    </button>
                  </Tooltip>
                </div>
              ),
            },
            // Automations is now a module-contributed door (order 10) in the
            // moduleNavEntries block below — automations left the Projects list
            // for the full-page surface (item 1707), so the hardcoded built-in
            // button + host project-picker menu retired.
            // Sprints toggles the global Sprint Engines aside (all sprints across projects).
            sprintEngineEnabled
              ? {
                  id: 'sprints',
                  order: 20,
                  node: (
                    <SidebarNavButton
                      collapsed={sidebarCollapsed}
                      icon={<SprintEngineWorkspaceTypeIcon className="icon-xs pointer-events-none shrink-0" />}
                      label="Sprints"
                      ariaLabel="Sprints"
                      tooltip="Sprints — all projects"
                      tooltipWhenExpanded
                      // The Sprints aside and Connectors surface live on their own
                      // persisted flags, independent of `activeGlobalSurface`. A door
                      // surface is the primary selection while open, so these defer to
                      // it — otherwise both a door row and (a persisted) Sprints row
                      // would highlight at once. The aside itself stays open; it just
                      // yields the "selected" idiom to the door.
                      active={sprintEnginesAsideOpen && !globalSurfaceActive}
                      onClick={() => setSprintEnginesAsideOpen(!sprintEnginesAsideOpen)}
                    />
                  ),
                }
              : null,
            {
              id: 'connectors',
              order: 30,
              node: (
                <SidebarNavButton
                  collapsed={sidebarCollapsed}
                  icon={<ConnectorsNavIcon className="icon-xs pointer-events-none shrink-0" />}
                  label="Connectors"
                  ariaLabel="Connectors"
                  tooltip="Connectors"
                  tooltipWhenExpanded
                  active={connectorsSurfaceOpen && !globalSurfaceActive}
                  onClick={() => openConnectorsSurface()}
                />
              ),
            },
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
        className={`my-2 h-px bg-[color:var(--border-subtle)] ${sidebarCollapsed ? 'mx-1.5' : 'mx-2'}`}
      />

      {/* Tree: Starred first, then folder groups directly — no "Projects"
          umbrella header; the folder headers are the top level (Cursor-parity).
          Sprint workspaces list under their project like any other workspace;
          the global sprint overview is the Sprints surface opened from the top
          nav.

          Alignment grid: every text column starts 36px from the sidebar edge —
          top-nav labels (mx-2 + px-2 + 12px icon + gap-2), section-header
          labels (pl-4 + 14px icon slot + gap-1.5), workspace-row content
          (mx-1.5 + 4px rail + pl-[26px]) and the fold row's chevron
          (mx-1.5 + pl-[30px]). Keep these in step when touching any one. */}
      <nav className="flex-1 overflow-y-auto pb-2" role="tree">
        {starredWorkspaces.length > 0 && sidebarCollapsed ? (
          <section className="relative" aria-label="Starred workspaces">
            {starredWorkspaces.map((workspace) =>
              renderWorkspaceRow(workspace, folderKey(workspace.folderPath), { keyPrefix: 'starred-' })
            )}
            <div aria-hidden="true" className="mx-2 my-1.5 h-px bg-[color:var(--border-subtle)]" />
          </section>
        ) : null}
        {starredWorkspaces.length > 0 && !sidebarCollapsed ? (
          <section className="relative pt-1" aria-label="Starred workspaces">
            <header
              onClick={() =>
                setStarredCollapsed((prev) => !prev)
              }
              className="group/folder relative flex h-[26px] cursor-pointer select-none items-center gap-1.5 pl-4 pr-2 text-[color:var(--text-muted)] hover:text-[color:var(--text-default)]"
            >
              {/* One icon slot, Cursor-style: the star at rest, the collapse
                  chevron swapped in on hover — no dedicated chevron column, so
                  child rows don't have to indent past it. */}
              <span className="relative flex h-[14px] w-[14px] shrink-0 items-center justify-center">
                <StarGlyph
                  filled
                  className="icon-sm shrink-0 text-[color:var(--tone-warn)] transition-opacity group-hover/folder:opacity-0"
                />
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  className={`icon-xs absolute inset-0 m-auto text-[color:var(--text-muted)] opacity-0 transition-[opacity,transform] group-hover/folder:opacity-100 ${
                    starredCollapsed ? '-rotate-90' : ''
                  }`}
                >
                  <path d="M5 6L8 9L11 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[color:var(--text-strong)]">
                Starred
              </span>
            </header>
            {!starredCollapsed
              ? starredWorkspaces.map((workspace) =>
                  renderWorkspaceRow(workspace, folderKey(workspace.folderPath), { keyPrefix: 'starred-' })
                )
              : null}
          </section>
        ) : null}
        {groups.map((group) => {
          const collapsed = collapsedFolders[group.key] === true
          // Each folder's rows are ordered by how recently each was worked on,
          // same as the Starred section — not by live status, so opening a row
          // never moves it. The stale-fold below still partitions by the 5-day
          // threshold; this only sets the order within the recent and folded
          // groups.
          const visibleWorkspaces = sortWorkspacesByActivity(
            sidebarCollapsed
              ? group.workspaces.filter((workspace) => !isStarred(workspace.highlight))
              : group.workspaces
          )
          if (sidebarCollapsed && visibleWorkspaces.length === 0) return null
          const dropMark =
            dropIndicator?.kind === 'folder' && dropIndicator.targetKey === group.key
              ? dropIndicator.position
              : null
          return (
            <section key={group.key} className="relative pt-1">
              {!sidebarCollapsed && (
                <header
                  draggable
                  onDragStart={(event) => handleFolderDragStart(event, group.key)}
                  onDragOver={(event) => handleFolderDragOver(event, group.key)}
                  onDrop={(event) => handleFolderDrop(event, group.key)}
                  onDragEnd={handleDragEnd}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest('[data-folder-overflow]')) return
                    setCollapsedFolders((prev) => ({ ...prev, [group.key]: !collapsed }))
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setFolderMenu({ folderKey: group.key, x: event.clientX, y: event.clientY })
                  }}
                  className={`group/folder relative flex h-[26px] cursor-pointer select-none items-center gap-1.5 pl-4 pr-2 text-[color:var(--text-muted)] hover:text-[color:var(--text-default)] ${
                    group.missing ? 'text-[color:var(--tone-warn)] hover:text-[color:var(--tone-warn)]' : ''
                  }`}
                >
                  {dropMark === 'before' ? (
                    <span aria-hidden="true" className="absolute inset-x-1 top-[-1px] h-[2px] rounded bg-[color:var(--accent-primary)]" />
                  ) : null}
                  {dropMark === 'after' ? (
                    <span aria-hidden="true" className="absolute inset-x-1 bottom-[-1px] h-[2px] rounded bg-[color:var(--accent-primary)]" />
                  ) : null}
                  {/* One icon slot, Cursor-style: the folder glyph at rest, the
                      collapse chevron swapped in on hover. */}
                  <span className="relative flex h-[14px] w-[14px] shrink-0 items-center justify-center">
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
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
                      className={`icon-xs absolute inset-0 m-auto text-[color:var(--text-muted)] opacity-0 transition-[opacity,transform] group-hover/folder:opacity-100 ${
                        collapsed ? '-rotate-90' : ''
                      }`}
                    >
                      <path d="M5 6L8 9L11 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[color:var(--text-strong)]"
                    title={group.fullPath ?? 'Workspaces with no folder'}
                  >
                    {group.displayName}
                  </span>
                  {group.missing ? (
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--tone-warn)]">
                      <StatusDot tone="warn" label="Folder missing" />
                      Missing
                    </span>
                  ) : null}
                  <Tooltip content="Folder actions">
                    <button
                      type="button"
                      data-folder-overflow="true"
                      onClick={(event) => {
                        event.stopPropagation()
                        setFolderMenu({
                          folderKey: group.key,
                          x: (event.currentTarget as HTMLElement).getBoundingClientRect().right,
                          y: (event.currentTarget as HTMLElement).getBoundingClientRect().bottom,
                        })
                      }}
                      className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded text-[color:var(--text-disabled)] opacity-0 hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] group-hover/folder:opacity-100"
                      aria-label="Folder actions"
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="icon-xs">
                        <circle cx="3.5" cy="8" r="1.2" />
                        <circle cx="8" cy="8" r="1.2" />
                        <circle cx="12.5" cy="8" r="1.2" />
                      </svg>
                    </button>
                  </Tooltip>
                </header>
              )}
              {renderFolderBody(group, visibleWorkspaces, collapsed)}
            </section>
          )
        })}
      </nav>

      {/* Sidebar-bottom account + Settings, relocated from WorkspaceTopBar
          (Cursor-parity). Pinned to the bottom because the <nav> above is
          flex-1; this is where the Automations rail used to sit (now a top-nav
          entry). */}
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
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
                >
                  <Icon className="icon-xs pointer-events-none shrink-0 text-[color:var(--text-subtle)]" />
                  <span className="min-w-0 flex-1 truncate">{`New ${model.label.toLowerCase()}`}</span>
                  {model.id === 'standard' ? (
                    <kbd className="shrink-0 font-mono text-[10px] text-[color:var(--text-disabled)]">Ctrl+T</kbd>
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

      {/* Delete with on-disk state (sprintengine / multiloop) */}
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
                  : workspace.mode === 'multiloop'
                    ? workspace.multiloopContext?.loopDirectoryPath ?? null
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
                    <label className="block">
                      <span className="mb-1.5 block text-[12px] font-medium text-[color:var(--text-default)]">
                        Type the workspace name to confirm
                      </span>
                      <input
                        autoFocus
                        value={deleteTypedName}
                        onChange={(event) => setDeleteTypedName(event.target.value)}
                        placeholder={workspace.name}
                        className="h-9 w-full rounded bg-[color:var(--bg-surface-raised)] px-2.5 text-[13px] text-[color:var(--text-strong)] outline-none transition-colors placeholder:text-[color:var(--text-disabled)] focus:ring-1 focus:ring-[color:var(--border-focus)]"
                      />
                    </label>
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

// Link glyph for the Connectors top-nav entry — a connector is a link to an
// external service (matches the icon family's 16-box round-stroke idiom).
function ConnectorsNavIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M6.6 9.4L9.4 6.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M8.7 4.6l.9-.9a2.3 2.3 0 0 1 3.3 3.3l-1.4 1.4a2.3 2.3 0 0 1-3.3 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.3 11.4l-.9.9a2.3 2.3 0 0 1-3.3-3.3l1.4-1.4a2.3 2.3 0 0 1 3.3 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
