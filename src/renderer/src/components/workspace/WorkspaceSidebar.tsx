import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NewChatIcon, WorkspaceTypeIcon, resolveEnabledWorkspaceType } from '../AppIcons'
import type { ModuleEnablementOverrides } from '../../../../shared/modules/manifest'
import {
  ContextMenu,
  InboxSearchInput,
  LifecycleGlyph,
  MenuDivider,
  MenuItem,
  MenuSwatchRow,
  PointerPopover,
  StarGlyph,
  StatusDot,
  Tooltip,
  type Tone,
} from '../ui'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import PanelRail from './PanelRail'
import SpawnAgentMenu from './SpawnAgentMenu'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type {
  AgentCli,
  HighlightColor,
  LayoutTemplate,
  SpecialistActionId,
  SprintEngineCliPermissionPreset,
  Workspace,
  WorkspaceId,
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
import { partitionWorkspacesByRecency, sortWorkspacesByActivity } from '../../utils/workspaceRecency'
import { beginSidebarTransition } from '../../utils/sidebarTransition'
import { filterWorkspacesBySearchQuery, normalizeWorkspaceSearchQuery } from '../../utils/workspaceSearch'

type Activity = 'working' | 'failed' | 'needs-input' | 'idle'

type TerminalRecency = { hasRunning: boolean; lastFinishedAt: number | null }

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
  onNewChat: () => void
  onNewChatInFolder: (folderPath: string) => void
  // New-chat spawn handlers wired to the shared SpawnAgentMenu picker. Each
  // creates a fresh solo-chat workspace; `folderPath` (the right-clicked folder,
  // or undefined for the New chat button) scopes it.
  onNewChatTerminal: (folderPath?: string | null) => void
  onNewChatGeneral: (cli: AgentCli, folderPath?: string | null) => void
  onNewChatSpecialist: (id: SpecialistActionId, cli: AgentCli, folderPath?: string | null) => void
  agentSpawnPermissionPreset: SprintEngineCliPermissionPreset
  setAgentSpawnPermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  onRevealFolder: (folderPath: string) => void
  onSetSidebarCollapsed: (collapsed: boolean) => void
}

type FolderGroup = {
  key: string
  displayName: string
  fullPath: string | null
  missing: boolean
  workspaces: Workspace[]
}

const NULL_FOLDER_KEY = '__no_folder__'

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
// 3 px left rail and the icon glyph carry the mode signal, while the active
// row body collapses onto the shared `--bg-active` surface. The previous
// per-mode blended backgrounds and decorative inset+glow halos have been
// dropped in favour of a hairline + identity-rail composition that matches
// the audit's one-accent restraint.
const modeAccents: Record<Workspace['mode'], RowAccent> = {
  sprintengine: {
    border: 'border-l-[color:var(--tool-sprintengine)]',
    bg: 'bg-[color:var(--bg-active)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: '',
    collapsedShadow: '',
    chip: 'bg-[color:var(--bg-hover)]',
    glyph: 'text-[color:var(--tool-sprintengine)]',
  },
  switchboard: {
    border: 'border-l-[color:var(--tool-switchboard)]',
    bg: 'bg-[color:var(--bg-active)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: '',
    collapsedShadow: '',
    chip: 'bg-[color:var(--bg-hover)]',
    glyph: 'text-[color:var(--tool-switchboard)]',
  },
  multiloop: {
    border: 'border-l-[color:var(--tool-multiloop)]',
    bg: 'bg-[color:var(--bg-active)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: '',
    collapsedShadow: '',
    chip: 'bg-[color:var(--bg-hover)]',
    glyph: 'text-[color:var(--tool-multiloop)]',
  },
  'guided-brief': {
    border: 'border-l-[color:var(--accent-primary)]',
    bg: 'bg-[color:var(--bg-active)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: '',
    collapsedShadow: '',
    chip: 'bg-[color:var(--bg-hover)]',
    glyph: 'text-[color:var(--accent-primary)]',
  },
  standard: {
    border: 'border-l-[color:var(--border-strong)]',
    bg: 'bg-[color:var(--bg-active)]',
    text: 'text-[color:var(--text-strong)]',
    shadow: '',
    collapsedShadow: '',
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
  return `border-l-[3px] ${accent.border} ${accent.bg} ${accent.text} ${accent.shadow}`
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
  return `border-l-[3px] ${swatch.border} ${swatch.dimBg}`
}

// Working rows carry no status dot: a busy agent reads as "now" in the recency
// column (see renderWorkspaceRow) rather than a green dot, so the dot is reserved
// for the two states that actually want attention — needs-input and failed.
function activityTone(activity: Activity): { tone: Tone; pulse: boolean } | null {
  if (activity === 'needs-input') return { tone: 'warn', pulse: true }
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

export default function WorkspaceSidebar({
  workspaces,
  activeWorkspaceId,
  workspaceWindowId,
  isDetachedWindow,
  sidebarCollapsed,
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
  onNewChatInFolder,
  onNewChatTerminal,
  onNewChatGeneral,
  onNewChatSpecialist,
  agentSpawnPermissionPreset,
  setAgentSpawnPermissionPreset,
  onRevealFolder,
  onSetSidebarCollapsed,
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
  const now = useRelativeNow()

  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({})
  const [expandedStaleFolders, setExpandedStaleFolders] = useState<Record<string, boolean>>({})
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState('')
  const [starredCollapsed, setStarredCollapsed] = useState(false)
  const [renamingId, setRenamingId] = useState<WorkspaceId | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [contextMenu, setContextMenu] = useState<{ workspaceId: WorkspaceId; x: number; y: number } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ folderKey: string; x: number; y: number } | null>(null)
  const [newChatMenu, setNewChatMenu] = useState<{ x: number; y: number; folderPath?: string } | null>(null)
  const [confirmClose, setConfirmClose] = useState<WorkspaceId | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<WorkspaceId | null>(null)
  const [confirmForget, setConfirmForget] = useState<string | null>(null)
  const [deleteTypedName, setDeleteTypedName] = useState('')

  const renameInputRef = useRef<HTMLInputElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
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

  const normalizedWorkspaceSearchQuery = useMemo(
    () => normalizeWorkspaceSearchQuery(workspaceSearchQuery),
    [workspaceSearchQuery]
  )
  const searchingWorkspaces = normalizedWorkspaceSearchQuery.length > 0
  const filteredWorkspaces = useMemo(
    () => filterWorkspacesBySearchQuery(workspaces, workspaceSearchQuery),
    [workspaceSearchQuery, workspaces]
  )
  const groups = useMemo(() => buildFolderGroups(filteredWorkspaces), [filteredWorkspaces])

  // A workspace is "live" while it shows a status dot — working, failed, or
  // waiting on input. Live rows sort above idle ones in the activity ordering.
  const isWorkspaceLive = useCallback(
    (workspace: Workspace) => (activityByWorkspaceId[workspace.id] ?? 'idle') !== 'idle',
    [activityByWorkspaceId]
  )

  // Starred workspaces surface in most-recently-active order: live ones on top,
  // then the rest by how long ago they were worked on. This supersedes manual
  // drag position within the Starred section.
  const starredWorkspaces = useMemo(
    () =>
      sortWorkspacesByActivity(
        filteredWorkspaces.filter((workspace) => isStarred(workspace.highlight)),
        isWorkspaceLive
      ),
    [filteredWorkspaces, isWorkspaceLive]
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

  useEffect(() => {
    if (sidebarCollapsed && workspaceSearchQuery) setWorkspaceSearchQuery('')
  }, [sidebarCollapsed, workspaceSearchQuery])

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
    const active = workspace.id === activeWorkspaceId
    const activity = activityByWorkspaceId[workspace.id] ?? 'idle'
    const tone = activityTone(activity)
    const recency = terminalRecencyByWorkspaceId[workspace.id]
    // Sprint Engine rows carry the run's lifecycle glyph in the status slot
    // instead of the dot + recency idiom: the run state (spinner / needs input
    // / paused / failed / done) is the signal a sprint workspace wants.
    // Recency still drives ordering and survives in the glyph's tooltip.
    const runGlyph = deriveWorkspaceRunGlyph(workspace, activity)
    const runGlyphRecencyAgo =
      runGlyph && typeof recency?.lastFinishedAt === 'number'
        ? formatRelativeMsAgo(recency.lastFinishedAt, now)
        : null
    const runGlyphLabel = runGlyph
      ? `${runGlyph.label}${runGlyphRecencyAgo ? ` · last terminal output ${runGlyphRecencyAgo}` : ''}`
      : null
    const showRecencyText =
      !sidebarCollapsed
      && !runGlyph
      && activity === 'idle'
      && !!recency
      && !recency.hasRunning
      && typeof recency.lastFinishedAt === 'number'
    // A working row has no dot anymore; it reads as "now" in the recency column,
    // the same idiom as a workspace whose terminal last spoke under a minute ago.
    const showWorkingNow = !sidebarCollapsed && !runGlyph && activity === 'working'
    // Collapsed rows keep the corner-dot idiom (a 16px glyph doesn't fit as an
    // overlay on the 20px icon); it derives from the same rollup so the two
    // presentations agree. Only the attention states earn the corner dot.
    const collapsedDot = runGlyph
      ? runGlyph.state === 'needs_input'
        ? { tone: 'warn' as Tone, pulse: true }
        : runGlyph.state === 'failed'
          ? { tone: 'error' as Tone, pulse: false }
          : null
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

    return (
      <div
        key={`${options?.keyPrefix ?? ''}${workspace.id}`}
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
        title={sidebarCollapsed ? `${workspace.name}${workspace.folderPath ? ` · ${folderDisplayName(workspace.folderPath)}` : ''}` : undefined}
        className={`group relative mx-1.5 my-[1px] flex h-[30px] cursor-pointer select-none items-center gap-2 rounded-md text-[13px] transition-colors ${
          sidebarCollapsed
            ? 'justify-center px-0'
            : 'border-l-[3px] border-l-transparent pl-[30px] pr-1.5'
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
                className={`flex min-w-0 flex-1 items-center gap-1.5 truncate ${folderMissing ? 'line-through decoration-[color:var(--text-subtle)]' : ''}`}
              >
                {starred ? (
                  <StarGlyph
                    filled
                    className="icon-xs shrink-0 text-[color:var(--tone-warn)]"
                    label="Starred"
                  />
                ) : null}
                <span
                  className={`min-w-0 truncate ${resident ? 'font-semibold text-[color:var(--text-strong)]' : ''}`}
                  title={workspace.name}
                >
                  {workspace.name}
                </span>
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
                {!runGlyph && tone ? <StatusDot tone={tone.tone} pulse={tone.pulse} label={activityLabel(activity)} /> : null}
                {showWorkingNow ? (
                  <span
                    className="text-[10px] tabular-nums text-[color:var(--text-subtle)]"
                    aria-label="Agents working now"
                  >
                    now
                  </span>
                ) : showRecencyText ? (
                  <span
                    className="text-[10px] tabular-nums text-[color:var(--text-subtle)]"
                    title={`Last terminal output ${formatRelativeMsAgo(recency!.lastFinishedAt!, now)} (${new Date(recency!.lastFinishedAt!).toLocaleString()})`}
                    aria-label={`Last terminal output ${formatRelativeMsAgo(recency!.lastFinishedAt!, now)}`}
                  >
                    {formatRelativeMs(recency!.lastFinishedAt!, now)}
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
    if (folderCollapsed && !sidebarCollapsed && !searchingWorkspaces) return null
    if (sidebarCollapsed) {
      return (
        <div className="border-b border-[color:var(--bg-hover)] pb-1.5 last:border-b-0">
          {visibleWorkspaces.map((workspace) => renderWorkspaceRow(workspace, group.key))}
        </div>
      )
    }

    if (searchingWorkspaces) {
      return (
        <div>
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

    const staleExpanded = expandedStaleFolders[group.key] === true
    const olderListId = `ws-older-${group.key.replace(/[^a-z0-9]+/giu, '-')}`

    return (
      <div>
        {recent.map((workspace) => renderWorkspaceRow(workspace, group.key))}
        <div
          id={olderListId}
          role="group"
          aria-label={`Older workspaces in ${group.displayName}`}
          hidden={!staleExpanded}
        >
          {stale.map((workspace) => renderWorkspaceRow(workspace, group.key))}
        </div>
        <button
          type="button"
          onClick={() =>
            setExpandedStaleFolders((prev) => ({ ...prev, [group.key]: !staleExpanded }))
          }
          aria-expanded={staleExpanded}
          aria-controls={olderListId}
          className="relative mx-1.5 my-[1px] flex h-[26px] w-[calc(100%-12px)] cursor-pointer select-none items-center gap-1.5 rounded-md pl-[30px] pr-1.5 text-[12px] text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            className={`icon-xs shrink-0 text-[color:var(--text-disabled)] transition-transform ${
              staleExpanded ? '' : '-rotate-90'
            }`}
          >
            <path d="M5 6L8 9L11 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="tabular-nums">
            {staleExpanded ? 'Show fewer' : `Show ${stale.length} older`}
          </span>
        </button>
      </div>
    )
  }

  return (
    <aside
      ref={sidebarRef}
      aria-label="Workspaces"
      className={`flex shrink-0 flex-col bg-[color:var(--bg-app)] transition-[width] duration-150 ease-out motion-reduce:transition-none ${
        sidebarCollapsed ? 'w-[44px]' : 'w-[296px]'
      }`}
    >
      {/*
       * Top chrome row: Files / Editor / Git / Knowledge Graph switches scoped
       * to the active workspace, plus the collapse toggle pinned to its right
       * edge. The brand moved to the window title bar, so the rail is the
       * sidebar's first row. It renders even with no active workspace so the
       * collapse toggle stays reachable.
       */}
      <PanelRail
        workspaceId={activeWorkspaceId}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => {
          // Protect the width-transition window: hold heavy panel resize work
          // (xterm fit, PTY resize, Monaco layout) until the glide lands, so it
          // runs once instead of every animation frame.
          beginSidebarTransition()
          onSetSidebarCollapsed(!sidebarCollapsed)
        }}
      />

      <div className={`mt-2 flex flex-col gap-1.5 ${sidebarCollapsed ? 'mx-1.5' : 'mx-2'}`}>
        {sidebarCollapsed ? (
          <>
            {/* New workspace — canonical create + tab-extract drop target */}
            <Tooltip content="New workspace (Ctrl+T) — drop a tab here to extract it" wrapperClassName="flex">
              <button
                type="button"
                onClick={onNewWorkspace}
                onDragOver={handleTabDragOverNew}
                onDragLeave={handleTabDragLeaveNew}
                onDrop={handleTabDropOnNew}
                className={`flex h-[34px] w-full shrink-0 items-center justify-center rounded-md border transition-colors ${
                  tabDropTarget?.kind === 'new'
                    ? 'border-[color:var(--accent-primary)] bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
                    : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-default)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
                }`}
                aria-label="New workspace"
              >
                <svg viewBox="0 0 16 16" fill="none" className="icon-xs pointer-events-none">
                  <path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </Tooltip>

            {/* New chat — quiet solo-agent quick spawn, subordinate to New workspace.
               Left-click spawns the last-used agent; right-click chooses the type. */}
            <Tooltip content="New chat · right-click to choose agent" wrapperClassName="flex">
              <button
                type="button"
                onClick={onNewChat}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setNewChatMenu({ x: event.clientX, y: event.clientY })
                }}
                className="flex h-[30px] w-full shrink-0 items-center justify-center rounded-md text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                aria-label="New chat"
              >
                <NewChatIcon className="icon-xs pointer-events-none" />
              </button>
            </Tooltip>
          </>
        ) : (
          // Single creation row: New workspace is the labeled primary (Ctrl+T,
          // tab-extract drop target); New chat is an attached compact segment
          // that spawns a solo-agent workspace. One row, one visual priority.
          <div
            className={`flex h-[34px] w-full shrink-0 overflow-hidden rounded-md border transition-colors ${
              tabDropTarget?.kind === 'new'
                ? 'border-[color:var(--accent-primary)] bg-[color:var(--bg-hover)]'
                : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)]'
            }`}
          >
            <Tooltip
              content="New workspace (Ctrl+T) — drop a tab here to extract it"
              wrapperClassName="flex min-w-0 flex-1"
            >
              <button
                type="button"
                onClick={onNewWorkspace}
                onDragOver={handleTabDragOverNew}
                onDragLeave={handleTabDragLeaveNew}
                onDrop={handleTabDropOnNew}
                className={`flex h-full w-full items-center justify-center gap-2 px-3 text-[12px] font-medium transition-colors ${
                  tabDropTarget?.kind === 'new'
                    ? 'text-[color:var(--text-strong)]'
                    : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
                }`}
                aria-label="New workspace"
              >
                <svg viewBox="0 0 16 16" fill="none" className="icon-xs pointer-events-none">
                  <path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span className="pointer-events-none truncate">
                  {tabDropTarget?.kind === 'new' ? 'Drop to extract' : 'New workspace'}
                </span>
              </button>
            </Tooltip>

            <span aria-hidden="true" className="w-px self-stretch bg-[color:var(--border-subtle)]" />

            <Tooltip content="New chat · right-click to choose agent" wrapperClassName="flex">
              <button
                type="button"
                onClick={onNewChat}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setNewChatMenu({ x: event.clientX, y: event.clientY })
                }}
                className="flex h-full w-9 shrink-0 items-center justify-center text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                aria-label="New chat"
              >
                <NewChatIcon className="icon-xs pointer-events-none" />
              </button>
            </Tooltip>
          </div>
        )}
      </div>

      {!sidebarCollapsed ? (
        <div className="mx-2 mt-2">
          <InboxSearchInput
            value={workspaceSearchQuery}
            onChange={setWorkspaceSearchQuery}
            ariaLabel="Search workspaces"
            placeholder="Search workspaces..."
            clearAriaLabel="Clear workspace search"
          />
        </div>
      ) : null}

      {/* Tree */}
      <nav className="mt-1 flex-1 overflow-y-auto pb-2" role="tree">
        {starredWorkspaces.length > 0 && sidebarCollapsed ? (
          <section className="relative" aria-label="Starred workspaces">
            {starredWorkspaces.map((workspace) =>
              renderWorkspaceRow(workspace, folderKey(workspace.folderPath), { keyPrefix: 'starred-' })
            )}
            <div aria-hidden="true" className="mx-2 my-1.5 h-px bg-[color:var(--border-subtle)]" />
          </section>
        ) : null}
        {starredWorkspaces.length > 0 && !sidebarCollapsed && !searchingWorkspaces ? (
          <section className="relative pt-1" aria-label="Starred workspaces">
            <header
              onClick={() =>
                setStarredCollapsed((prev) => !prev)
              }
              className="group/folder relative flex h-[26px] cursor-pointer select-none items-center gap-1.5 px-2 text-[color:var(--text-muted)] hover:text-[color:var(--text-default)]"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                className={`icon-xs shrink-0 text-[color:var(--text-disabled)] transition-transform ${
                  starredCollapsed ? '-rotate-90' : ''
                }`}
              >
                <path d="M5 6L8 9L11 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <StarGlyph filled className="icon-sm shrink-0 text-[color:var(--tone-warn)]" />
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
          // Each folder's rows are ordered by most-recent activity, same as the
          // Starred section: live rows first, then by how long ago each was
          // worked on. The stale-fold below still partitions by the 5-day
          // threshold; this only sets the order within the recent and folded
          // groups.
          const visibleWorkspaces = sortWorkspacesByActivity(
            sidebarCollapsed
              ? group.workspaces.filter((workspace) => !isStarred(workspace.highlight))
              : group.workspaces,
            isWorkspaceLive
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
                  className={`group/folder relative flex h-[26px] cursor-pointer select-none items-center gap-1.5 px-2 text-[color:var(--text-muted)] hover:text-[color:var(--text-default)] ${
                    group.missing ? 'text-[color:var(--tone-warn)] hover:text-[color:var(--tone-warn)]' : ''
                  }`}
                >
                  {dropMark === 'before' ? (
                    <span aria-hidden="true" className="absolute inset-x-1 top-[-1px] h-[2px] rounded bg-[color:var(--accent-primary)]" />
                  ) : null}
                  {dropMark === 'after' ? (
                    <span aria-hidden="true" className="absolute inset-x-1 bottom-[-1px] h-[2px] rounded bg-[color:var(--accent-primary)]" />
                  ) : null}
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    className={`icon-xs shrink-0 text-[color:var(--text-disabled)] transition-transform ${
                      collapsed ? '-rotate-90' : ''
                    }`}
                  >
                    <path d="M5 6L8 9L11 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <svg viewBox="0 0 16 16" fill="none" className="icon-sm shrink-0">
                    <path
                      d="M2 4.5C2 3.67 2.67 3 3.5 3H6.5L8 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z"
                      stroke="currentColor"
                      strokeWidth="1.4"
                    />
                  </svg>
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
        {searchingWorkspaces && filteredWorkspaces.length === 0 && !sidebarCollapsed ? (
          <div className="mx-3 mt-4 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-3 text-[12px] text-[color:var(--text-muted)]">
            No workspaces found
          </div>
        ) : null}
      </nav>

      {/* Context menu (workspace row) */}
      {contextMenu ? (
        <WorkspaceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          workspace={workspaceById.get(contextMenu.workspaceId) ?? null}
          isDetachedWindow={isDetachedWindow}
          onClose={() => setContextMenu(null)}
          onPickNewChatAgent={(x, y) => {
            const workspace = workspaceById.get(contextMenu.workspaceId)
            setContextMenu(null)
            if (workspace?.folderPath && !workspace.folderMissing) {
              setNewChatMenu({ x, y, folderPath: workspace.folderPath })
            }
          }}
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
          onPickNewChatAgent={(x, y) => {
            const group = groups.find((g) => g.key === folderMenu.folderKey)
            setFolderMenu(null)
            if (group?.fullPath && !group.missing) {
              setNewChatMenu({ x, y, folderPath: group.fullPath })
            }
          }}
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

      {/* New chat agent picker (right-click on the New chat control, or a
          folder/workspace context menu). Reuses the top bar's SpawnAgentMenu so
          a new chat can launch any specialist/terminal/general agent; every pick
          opens a fresh solo chat scoped to newChatMenu.folderPath. */}
      {newChatMenu ? (
        <PointerPopover
          x={newChatMenu.x}
          y={newChatMenu.y}
          ariaLabel="Start a new chat with"
          onClose={() => setNewChatMenu(null)}
        >
          <SpawnAgentMenu
            multiloopLaunchMenu={false}
            // The sidebar New chat always creates a standard solo workspace, so
            // the conversation row (which needs a provider loaded for the active
            // standard workspace) is omitted here; Terminal, General, and every
            // specialist are wired below.
            conversationSpawnAvailable={false}
            agentSpawnPermissionPreset={agentSpawnPermissionPreset}
            onChangeAgentSpawnPermissionPreset={setAgentSpawnPermissionPreset}
            onSpawnTerminal={() => onNewChatTerminal(newChatMenu.folderPath)}
            onSpawnGeneral={(cli) => onNewChatGeneral(cli, newChatMenu.folderPath)}
            onSpawnConversation={() => {}}
            onSpawnSpecialist={(id, cli) => onNewChatSpecialist(id, cli, newChatMenu.folderPath)}
            onSpawnMultiloopRole={() => {}}
            showOpenInNewChat={false}
            onClose={() => setNewChatMenu(null)}
          />
        </PointerPopover>
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
  onPickNewChatAgent,
}: {
  x: number
  y: number
  workspace: Workspace | null
  isDetachedWindow: boolean
  onClose: () => void
  onSelect: (action: ContextMenuAction) => void
  onPickColor: (color: HighlightColor) => void
  onPickNewChatAgent: (x: number, y: number) => void
}) {
  if (!workspace) return null
  const showDelete = workspaceHasOnDiskState(workspace)
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
        <MenuItem
          onClick={() => onSelect('new-chat')}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onPickNewChatAgent(event.clientX, event.clientY)
          }}
        >
          New chat in project
        </MenuItem>
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
  onPickNewChatAgent,
}: {
  x: number
  y: number
  group: FolderGroup | null
  onClose: () => void
  onSelect: (action: FolderMenuAction) => void
  onPickNewChatAgent: (x: number, y: number) => void
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
        <MenuItem
          onClick={() => onSelect('new-chat')}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onPickNewChatAgent(event.clientX, event.clientY)
          }}
        >
          New chat in project
        </MenuItem>
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
