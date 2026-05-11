import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StatusDot, WorkspaceTypeIcon } from '../AppIcons'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type {
  HighlightColor,
  LayoutTemplate,
  Workspace,
  WorkspaceId,
} from '../../types/workspace'
import {
  HIGHLIGHT_COLORS,
  getHighlightSwatch,
  hasHighlightOverride,
  isStarred,
} from '../../utils/highlight'
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

type Activity = 'running' | 'needs-input' | 'idle'

type WorkspaceSidebarProps = {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  sidebarCollapsed: boolean
  activityByWorkspaceId: Record<WorkspaceId, Activity>
  onSelectWorkspace: (id: WorkspaceId) => void
  onCloseWorkspace: (id: WorkspaceId) => void
  onDeleteWorkspaceWithState: (id: WorkspaceId) => Promise<void> | void
  onForgetFolder: (folderPath: string) => void
  onNewWorkspace: () => void
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

const modeAccents: Record<Workspace['mode'], RowAccent> = {
  sprintengine: {
    border: 'border-l-[#ffbf2f]',
    bg: 'bg-[#1a1408]',
    text: 'text-[#ffe7b3]',
    shadow:
      'shadow-[inset_0_0_0_1px_rgba(255,191,47,0.18),0_0_24px_-4px_rgba(255,191,47,0.40)]',
    collapsedShadow:
      'shadow-[inset_0_0_0_1px_rgba(255,191,47,0.20),0_0_10px_-3px_rgba(255,191,47,0.22)]',
    chip: 'bg-[#ffbf2f]/15',
    glyph: 'text-[#ffbf2f]',
  },
  switchboard: {
    border: 'border-l-[#7c5cf2]',
    bg: 'bg-[#150f2c]',
    text: 'text-[#efe5ff]',
    shadow:
      'shadow-[inset_0_0_0_1px_rgba(124,92,242,0.28),0_0_24px_-4px_rgba(124,92,242,0.50)]',
    collapsedShadow:
      'shadow-[inset_0_0_0_1px_rgba(124,92,242,0.26),0_0_10px_-3px_rgba(124,92,242,0.28)]',
    chip: 'bg-[#7c5cf2]/18',
    glyph: 'text-[#a78bfa]',
  },
  multiloop: {
    border: 'border-l-[#5c7cff]',
    bg: 'bg-[#15203c]',
    text: 'text-[#dfe6ff]',
    shadow:
      'shadow-[inset_0_0_0_1px_rgba(92,124,255,0.25),0_0_24px_-4px_rgba(92,124,255,0.45)]',
    collapsedShadow:
      'shadow-[inset_0_0_0_1px_rgba(92,124,255,0.24),0_0_10px_-3px_rgba(92,124,255,0.26)]',
    chip: 'bg-[#5c7cff]/18',
    glyph: 'text-[#5c7cff]',
  },
  standard: {
    border: 'border-l-[#a8a8b2]',
    bg: 'bg-[#181a20]',
    text: 'text-[#ffffff]',
    shadow: 'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]',
    collapsedShadow: 'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.10)]',
    chip: 'bg-[#9a9aa2]/12',
    glyph: 'text-[#9a9aa2]',
  },
}

// Effective accent for a workspace row. When the workspace has a highlight
// color, it overrides the mode accent everywhere except the icon glyph
// shape (which still tells the user which mode the workspace is in).
function rowAccent(workspace: Workspace): RowAccent {
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
  return modeAccents[workspace.mode] ?? modeAccents.standard
}

function activeRowClass(workspace: Workspace): string {
  const accent = rowAccent(workspace)
  return `border-l-[3px] ${accent.border} ${accent.bg} ${accent.text} ${accent.shadow}`
}

function collapsedActiveRowClass(workspace: Workspace): string {
  const accent = rowAccent(workspace)
  return `${accent.bg} ${accent.text} ${accent.collapsedShadow}`
}

// Class fragment applied to inactive rows that have a highlight color set,
// so the user spots their starred/highlighted workspaces in the list at a
// glance even when not active. Uses just the colored left border — no bg,
// no halo — so the row stays scannable.
function inactiveHighlightClass(workspace: Workspace): string {
  if (!hasHighlightOverride(workspace.highlight)) return ''
  const swatch = getHighlightSwatch(workspace.highlight!.color!)
  return `border-l-[3px] ${swatch.border}`
}

function activityTone(activity: Activity): 'running' | 'needs-input' | null {
  if (activity === 'needs-input') return 'needs-input'
  if (activity === 'running') return 'running'
  return null
}

function activityLabel(activity: Activity): string {
  if (activity === 'needs-input') return 'Workspace needs input'
  if (activity === 'running') return 'Workspace has running agents'
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

function workspaceHasOnDiskState(workspace: Workspace): boolean {
  if (workspace.mode === 'sprintengine') return Boolean(workspace.sprintEngineContext?.teamDirectoryPath)
  if (workspace.mode === 'multiloop') return Boolean(workspace.multiloopContext?.loopDirectoryPath)
  return false
}

export default function WorkspaceSidebar({
  workspaces,
  activeWorkspaceId,
  sidebarCollapsed,
  activityByWorkspaceId,
  onSelectWorkspace,
  onCloseWorkspace,
  onDeleteWorkspaceWithState,
  onForgetFolder,
  onNewWorkspace,
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

  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({})
  const [starredCollapsed, setStarredCollapsed] = useState(false)
  const [renamingId, setRenamingId] = useState<WorkspaceId | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [contextMenu, setContextMenu] = useState<{ workspaceId: WorkspaceId; x: number; y: number } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ folderKey: string; x: number; y: number } | null>(null)
  const [confirmClose, setConfirmClose] = useState<WorkspaceId | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<WorkspaceId | null>(null)
  const [confirmForget, setConfirmForget] = useState<string | null>(null)
  const [deleteTypedName, setDeleteTypedName] = useState('')

  const renameInputRef = useRef<HTMLInputElement>(null)
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

  const groups = useMemo(() => buildFolderGroups(workspaces), [workspaces])

  const starredWorkspaces = useMemo(
    () => workspaces.filter((workspace) => isStarred(workspace.highlight)),
    [workspaces]
  )

  const workspaceById = useMemo(() => {
    const map = new Map<WorkspaceId, Workspace>()
    for (const ws of workspaces) map.set(ws.id, ws)
    return map
  }, [workspaces])

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  // Close any open menu/popover on outside pointerdown or Escape
  useEffect(() => {
    if (!contextMenu && !folderMenu) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-sidebar-menu]')) return
      setContextMenu(null)
      setFolderMenu(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null)
        setFolderMenu(null)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu, folderMenu])

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
      if (activity === 'running' || activity === 'needs-input') {
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

  const handleDragEnd = () => {
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
      })

      migrateTabSideEffects(payload, newWorkspaceId)
      removeTab(payload.sourceWorkspaceId, payload.tabId)
    },
    [addWorkspaceFromStore, migrateTabSideEffects, workspaceById]
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
      removeTab(payload.sourceWorkspaceId, payload.tabId)
      setActiveWorkspace(workspace.id)
    },
    [migrateTabSideEffects, setActiveWorkspace, updateLayout]
  )

  const renderWorkspaceRow = (workspace: Workspace, fKey: string, options?: { keyPrefix?: string }) => {
    const active = workspace.id === activeWorkspaceId
    const activity = activityByWorkspaceId[workspace.id] ?? 'idle'
    const tone = activityTone(activity)
    const folderMissing = workspace.folderMissing === true
    const starred = isStarred(workspace.highlight)
    const highlighted = hasHighlightOverride(workspace.highlight)
    const accent = rowAccent(workspace)
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
            : 'border-l-[3px] border-l-transparent pl-[19px] pr-2'
        } ${
          active
            ? sidebarCollapsed
              ? collapsedActiveRowClass(workspace)
              : activeRowClass(workspace)
            : highlighted && !sidebarCollapsed
              ? `${inactiveHighlightClass(workspace)} text-[#d7d7dc] hover:bg-[#111216] hover:text-[#ececee]`
              : 'text-[#d7d7dc] hover:bg-[#111216] hover:text-[#ececee]'
        } ${folderMissing ? 'opacity-70' : ''}`}
        role="treeitem"
        aria-current={active ? 'true' : undefined}
      >
        {dropMark === 'before' ? (
          <span aria-hidden="true" className="absolute inset-x-1 top-[-1px] h-[2px] rounded bg-[#5c7cff]" />
        ) : null}
        {dropMark === 'after' ? (
          <span aria-hidden="true" className="absolute inset-x-1 bottom-[-1px] h-[2px] rounded bg-[#5c7cff]" />
        ) : null}
        {isTabDropTarget ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-[#5c7cff] ring-offset-0"
          />
        ) : null}

        <span
          className={`flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-md transition-colors ${
            active || highlighted ? accent.chip : ''
          }`}
        >
          <WorkspaceTypeIcon
            mode={workspace.mode}
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
                className="min-w-0 flex-1 rounded border border-[#303139] bg-[#090a0c] px-1.5 py-0 text-[13px] text-[#ececee] focus:outline-none"
              />
            ) : (
              <span
                className={`flex min-w-0 flex-1 items-center gap-1.5 truncate ${folderMissing ? 'line-through decoration-[rgba(255,255,255,0.2)]' : ''}`}
              >
                {starred ? (
                  <svg
                    className="h-3 w-3 shrink-0 text-[#ffbf2f] drop-shadow-[0_0_4px_rgba(255,191,47,0.6)]"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-label="Starred"
                  >
                    <title>Starred</title>
                    <path d="M8 1.5L9.95 5.7L14.5 6.3L11.2 9.55L12 14.1L8 11.95L4 14.1L4.8 9.55L1.5 6.3L6.05 5.7L8 1.5Z" />
                  </svg>
                ) : null}
                <span className="min-w-0 truncate">{workspace.name}</span>
              </span>
            )}

            {folderMissing ? (
              <svg
                className="h-3 w-3 shrink-0 text-[#ffb04a]"
                viewBox="0 0 16 16"
                fill="none"
                aria-label="Folder missing"
              >
                <path d="M8 1L15 14H1L8 1Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                <path d="M8 6V9M8 11.5V11.51" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            ) : null}

            {tone ? <StatusDot tone={tone} label={activityLabel(activity)} className="ml-0.5" /> : null}

            <span className="ml-1 inline-flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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
                className="inline-flex h-5 w-5 items-center justify-center rounded text-[#5a5a63] hover:bg-[#17181d] hover:text-[#d7d7dc]"
                aria-label="Workspace actions"
                title="More actions"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
                  <circle cx="3.5" cy="8" r="1.2" />
                  <circle cx="8" cy="8" r="1.2" />
                  <circle cx="12.5" cy="8" r="1.2" />
                </svg>
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  handleClose(workspace.id)
                }}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-[#5a5a63] hover:bg-[#17181d] hover:text-[#d7d7dc]"
                aria-label={`Close ${workspace.name}`}
                title="Close workspace"
              >
                <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3">
                  <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          </>
        )}

        {sidebarCollapsed && tone ? (
          <span
            className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${
              tone === 'needs-input'
                ? 'animate-pulse bg-[#ffbf2f] shadow-[0_0_8px_rgba(255,191,47,0.75)]'
                : 'bg-[#30d158]'
            }`}
            aria-hidden="true"
          />
        ) : null}

        {sidebarCollapsed && starred ? (
          <span
            className="absolute right-0.5 bottom-0.5 text-[8px] leading-none text-[#ffbf2f] drop-shadow-[0_0_3px_rgba(255,191,47,0.65)]"
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

  return (
    <aside
      aria-label="Workspaces"
      className={`flex shrink-0 flex-col border-r border-[#1f2025] bg-[#0b0c0f] transition-[width] duration-150 ease-out ${
        sidebarCollapsed ? 'w-[44px]' : 'w-[264px]'
      }`}
    >
      {/* Header */}
      <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-[#1f2025] px-2">
        {!sidebarCollapsed && (
          <div className="flex min-w-0 flex-1 items-center gap-2 pl-1.5 text-[13px] font-semibold text-[#d7d7dc]">
            <span className="h-4 w-4 shrink-0 rounded bg-gradient-to-br from-[#5c7cff] to-[#7c5cf2]" />
            <span className="truncate">Multicode</span>
          </div>
        )}
        <button
          type="button"
          onClick={() => onSetSidebarCollapsed(!sidebarCollapsed)}
          className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-[#9a9aa2] transition-colors hover:bg-[#15161a] hover:text-[#d7d7dc]"
          title={sidebarCollapsed ? 'Open sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
          aria-label={sidebarCollapsed ? 'Open sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? (
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
              <rect x="2.5" y="3" width="3.5" height="10" rx="1" stroke="currentColor" strokeWidth="1.5" />
              <path d="M9.5 8H13.5M11.5 6L13.5 8L11.5 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
              <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>

      {/* New workspace */}
      <button
        type="button"
        onClick={onNewWorkspace}
        onDragOver={handleTabDragOverNew}
        onDragLeave={handleTabDragLeaveNew}
        onDrop={handleTabDropOnNew}
        className={`mt-2 inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-md border border-dashed text-[12px] font-medium transition-colors ${
          tabDropTarget?.kind === 'new'
            ? 'border-[#5c7cff] bg-[#15161a] text-[#ececee]'
            : 'border-[#2a2b31] text-[#9a9aa2] hover:border-[#3a3d49] hover:bg-[#15161a] hover:text-[#d7d7dc]'
        } ${sidebarCollapsed ? 'mx-1.5' : 'mx-2'}`}
        title="New workspace (Ctrl+T) — drop a tab here to extract it"
        aria-label="New workspace"
      >
        <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3">
          <path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        {!sidebarCollapsed && (
          <span>{tabDropTarget?.kind === 'new' ? 'Drop to extract' : 'New workspace'}</span>
        )}
      </button>

      {/* Tree */}
      <nav className="mt-1 flex-1 overflow-y-auto pb-2" role="tree">
        {starredWorkspaces.length > 0 && sidebarCollapsed ? (
          <section className="relative" aria-label="Starred workspaces">
            {starredWorkspaces.map((workspace) =>
              renderWorkspaceRow(workspace, folderKey(workspace.folderPath), { keyPrefix: 'starred-' })
            )}
            <div aria-hidden="true" className="mx-2 my-1.5 h-px bg-[#1f2025]" />
          </section>
        ) : null}
        {starredWorkspaces.length > 0 && !sidebarCollapsed ? (
          <section className="relative pt-1" aria-label="Starred workspaces">
            <header
              onClick={() =>
                setStarredCollapsed((prev) => !prev)
              }
              className="group/folder relative flex h-[26px] cursor-pointer select-none items-center gap-1.5 px-2 text-[#9a9aa2] hover:text-[#d7d7dc]"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                className={`h-3 w-3 shrink-0 text-[#5a5a63] transition-transform ${
                  starredCollapsed ? '-rotate-90' : ''
                }`}
              >
                <path d="M5 6L8 9L11 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className="h-3.5 w-3.5 shrink-0 text-[#ffbf2f] drop-shadow-[0_0_4px_rgba(255,191,47,0.55)]"
                aria-hidden="true"
              >
                <path d="M8 1.5L9.95 5.7L14.5 6.3L11.2 9.55L12 14.1L8 11.95L4 14.1L4.8 9.55L1.5 6.3L6.05 5.7L8 1.5Z" />
              </svg>
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-[0.02em]">
                Starred
              </span>
              <span className="text-[10px] tabular-nums text-[#5a5a63]">{starredWorkspaces.length}</span>
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
          const visibleWorkspaces = sidebarCollapsed
            ? group.workspaces.filter((workspace) => !isStarred(workspace.highlight))
            : group.workspaces
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
                  className={`group/folder relative flex h-[26px] cursor-pointer select-none items-center gap-1.5 px-2 text-[#9a9aa2] hover:text-[#d7d7dc] ${
                    group.missing ? 'text-[#d4a26a] hover:text-[#ffb04a]' : ''
                  }`}
                >
                  {dropMark === 'before' ? (
                    <span aria-hidden="true" className="absolute inset-x-1 top-[-1px] h-[2px] rounded bg-[#5c7cff]" />
                  ) : null}
                  {dropMark === 'after' ? (
                    <span aria-hidden="true" className="absolute inset-x-1 bottom-[-1px] h-[2px] rounded bg-[#5c7cff]" />
                  ) : null}
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    className={`h-3 w-3 shrink-0 text-[#5a5a63] transition-transform ${
                      collapsed ? '-rotate-90' : ''
                    }`}
                  >
                    <path d="M5 6L8 9L11 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0">
                    <path
                      d="M2 4.5C2 3.67 2.67 3 3.5 3H6.5L8 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z"
                      stroke="currentColor"
                      strokeWidth="1.4"
                    />
                  </svg>
                  <span
                    className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-[0.02em]"
                    title={group.fullPath ?? 'Workspaces with no folder'}
                  >
                    {group.displayName}
                  </span>
                  <span className="text-[10px] tabular-nums text-[#5a5a63]">{group.workspaces.length}</span>
                  {group.missing ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#ffb04a]">
                      Missing
                    </span>
                  ) : null}
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
                    className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded text-[#5a5a63] opacity-0 hover:bg-[#17181d] hover:text-[#d7d7dc] group-hover/folder:opacity-100"
                    aria-label="Folder actions"
                    title="Folder actions"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
                      <circle cx="3.5" cy="8" r="1.2" />
                      <circle cx="8" cy="8" r="1.2" />
                      <circle cx="12.5" cy="8" r="1.2" />
                    </svg>
                  </button>
                </header>
              )}
              {(!collapsed || sidebarCollapsed) && (
                <div className={sidebarCollapsed ? 'border-b border-[#15161a] pb-1.5 last:border-b-0' : ''}>
                  {visibleWorkspaces.map((workspace) => renderWorkspaceRow(workspace, group.key))}
                </div>
              )}
            </section>
          )
        })}
      </nav>

      {/* Context menu (workspace row) */}
      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          workspace={workspaceById.get(contextMenu.workspaceId) ?? null}
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
            if (action === 'reveal' && workspace.folderPath) {
              onRevealFolder(workspace.folderPath)
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
          onSelect={(action) => {
            const group = groups.find((g) => g.key === folderMenu.folderKey)
            setFolderMenu(null)
            if (!group) return
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
                      <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.14em] text-[#5a5a63]">
                        Type the workspace name to confirm
                      </span>
                      <input
                        autoFocus
                        value={deleteTypedName}
                        onChange={(event) => setDeleteTypedName(event.target.value)}
                        placeholder={workspace.name}
                        className="h-9 w-full rounded bg-[#111216] px-2.5 text-[13px] text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:ring-1 focus:ring-[#ff5a5f]/45"
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

type ContextMenuAction = 'open' | 'rename' | 'reveal' | 'close' | 'delete' | 'toggle-star' | 'clear-color'

function ContextMenu({
  x,
  y,
  workspace,
  onClose,
  onSelect,
  onPickColor,
}: {
  x: number
  y: number
  workspace: Workspace | null
  onClose: () => void
  onSelect: (action: ContextMenuAction) => void
  onPickColor: (color: HighlightColor) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [onClose])

  if (!workspace) return null
  const showDelete = workspaceHasOnDiskState(workspace)
  const folderPathExists = Boolean(workspace.folderPath) && !workspace.folderMissing
  const starred = isStarred(workspace.highlight)
  const currentColor = workspace.highlight?.color ?? null

  return (
    <div
      ref={ref}
      data-sidebar-menu="true"
      role="menu"
      style={{ position: 'fixed', left: x, top: y, zIndex: 60 }}
      className="min-w-[240px] rounded-md border border-[#303139] bg-[#0d0e11] p-1 text-[13px] text-[#d7d7dc] shadow-[0_18px_50px_rgba(0,0,0,0.5)]"
    >
      <MenuItem onClick={() => onSelect('open')}>Open</MenuItem>
      <MenuItem onClick={() => onSelect('rename')} shortcut="F2">
        Rename
      </MenuItem>
      {folderPathExists ? <MenuItem onClick={() => onSelect('reveal')}>Reveal folder</MenuItem> : null}
      <MenuDivider />
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={starred}
        onClick={() => onSelect('toggle-star')}
        className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
      >
        <svg
          viewBox="0 0 16 16"
          fill={starred ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.4"
          className={`h-3.5 w-3.5 shrink-0 ${starred ? 'text-[#ffbf2f]' : 'text-[#5a5a63]'}`}
        >
          <path d="M8 1.5L9.95 5.7L14.5 6.3L11.2 9.55L12 14.1L8 11.95L4 14.1L4.8 9.55L1.5 6.3L6.05 5.7L8 1.5Z" strokeLinejoin="round" />
        </svg>
        <span className="min-w-0 flex-1 truncate">{starred ? 'Unstar' : 'Star'}</span>
      </button>
      <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#5a5a63]">
        Highlight color
      </div>
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <button
          type="button"
          onClick={() => onSelect('clear-color')}
          aria-label="Clear color"
          title="Clear color"
          className={`flex h-5 w-5 items-center justify-center rounded-full border border-[#303139] text-[#5a5a63] transition-colors hover:border-[#5a5a63] hover:text-[#d7d7dc] ${
            currentColor === null ? 'ring-1 ring-[#d7d7dc]' : ''
          }`}
        >
          <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3">
            <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        {HIGHLIGHT_COLORS.map((color) => {
          const swatch = getHighlightSwatch(color)
          const selected = currentColor === color
          return (
            <button
              key={color}
              type="button"
              onClick={() => onPickColor(color)}
              aria-label={`Highlight ${swatch.label}`}
              title={swatch.label}
              className={`h-5 w-5 rounded-full transition-transform hover:scale-110 ${
                selected ? 'ring-2 ring-offset-1 ring-offset-[#0d0e11]' : ''
              }`}
              style={{
                backgroundColor: swatch.hex,
                boxShadow: selected ? `0 0 8px ${swatch.ringRgba(0.6)}` : undefined,
                ['--tw-ring-color' as never]: swatch.hex,
              }}
            />
          )
        })}
      </div>
      <MenuDivider />
      <MenuItem onClick={() => onSelect('close')}>Close workspace</MenuItem>
      {showDelete ? (
        <MenuItem variant="danger" onClick={() => onSelect('delete')}>
          Delete workspace…
        </MenuItem>
      ) : null}
    </div>
  )
}

type FolderMenuAction = 'reveal' | 'forget'

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
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [onClose])

  if (!group) return null
  const canReveal = Boolean(group.fullPath) && !group.missing
  const canForget = Boolean(group.fullPath)

  return (
    <div
      ref={ref}
      data-sidebar-menu="true"
      role="menu"
      style={{ position: 'fixed', left: x, top: y, zIndex: 60 }}
      className="min-w-[220px] rounded-md border border-[#303139] bg-[#0d0e11] p-1 text-[13px] text-[#d7d7dc] shadow-[0_18px_50px_rgba(0,0,0,0.5)]"
    >
      {canReveal ? <MenuItem onClick={() => onSelect('reveal')}>Reveal folder</MenuItem> : null}
      {canForget ? (
        <MenuItem variant="danger" onClick={() => onSelect('forget')}>
          Forget folder…
        </MenuItem>
      ) : null}
    </div>
  )
}

function MenuItem({
  children,
  onClick,
  shortcut,
  variant,
}: {
  children: React.ReactNode
  onClick: () => void
  shortcut?: string
  variant?: 'danger'
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left transition-colors ${
        variant === 'danger'
          ? 'text-[#ff787c] hover:bg-[rgba(255,120,124,0.08)]'
          : 'text-[#d7d7dc] hover:bg-[#17181d] hover:text-[#ececee]'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? <span className="text-[11px] text-[#5a5a63] font-mono">{shortcut}</span> : null}
    </button>
  )
}

function MenuDivider() {
  return <div className="my-1 h-px bg-[#1f2025]" />
}
