import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderTypeIcon, GitBranchGlyph, NewChatIcon, RemoteMachineGlyph, SprintEngineMarkIcon } from '../AppIcons'
import CliIcon from '../CliIcon'
import { isLiveTerminal, useTerminalSessions } from '../../hooks/useTerminalSessions'
import { hasTerminalSessionsSnapshot } from '../../hooks/terminalSessionsStore'
import { useSidebarGitSummaries } from './useSidebarGitSummaries'
import { checkoutPathsOf, diffScopeCopy, lineOfRemoteRow, terminalLinesOf, type TerminalLine } from './terminalLines'
import { terminateWorkspaceTerminals } from './workspaceTerminalTermination'
import { ConversationPeekPopover } from './ConversationPeekPopover'
import { PullRequestMark, refreshPullRequestsForLine, shouldLookUpPullRequests } from './PullRequestMark'
import { peekStatusOf, rowConversationPeekIdentities } from './conversationPeekRow'
import { changelistOwnerId } from '../../../../shared/git/changelists'
import { labelForCliRuntime } from './newWorkspace/cliRuntimeOptions'
import type { AgentCli } from '../../../../shared/electron-api'
import { folderIdentityKey, useFolderRepositoryIdentities, type FolderIdentityMap } from './useFolderRepositoryIdentities'
import { FolderIdentityIcon } from './FolderIdentityIcon'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import { FOCUS_RING_CLASS } from '../ui/tokens'
import { startColumnResizeDrag } from './columnResizeDrag'
import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  resolveSidebarResize,
} from './sidebarWidth'
import {
  ContextMenu,
  Field,
  IconButton,
  Input,
  LifecycleGlyph,
  LinkButton,
  MenuDivider,
  AgentWorkingDots,
  MenuItem,
  MenuSwatchRow,
  ProjectColorSwatchRow,
  RowButton,
  StarGlyph,
  StatusDot,
  Tooltip,
  TruncatedText,
  type Tone,
} from '../ui'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import { ExtensionsRail } from './ExtensionsRail'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  type HighlightColor,
  type LayoutTemplate,
  type Workspace,
  type WorkspaceId,
} from '../../types/workspace'
import { getHighlightSwatch, hasHighlightOverride, isStarred } from '../../utils/highlight'
import {
  projectColorKey,
  resolveProjectColor,
  type ProjectColor,
  type ProjectColorSetting,
} from '../../utils/projectColor'
import { useAssignProjectColors, useProjectColors } from '../../hooks/useProjectColors'
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
import { useRemoteSessions } from './remoteBand/useRemoteSessions'
import {
  buildRemoteBand,
  openSpecOf,
  remoteBandItems,
  type RemoteSessionOpenSpec,
  type RemoteSessionRow,
} from './remoteBand/remoteSessionsModel'
import { shortMachineName } from '../remote/machineRowModel'
import { useChangePulse } from '../../hooks/useChangePulse'
import { formatElapsedMs, formatRelativeMs, formatRelativeMsAgo } from '../../utils/relativeTime'
import { deriveWorkspaceRunGlyph } from '../../utils/workspaceRunGlyph'
import { workspaceProjectRoot } from '../../utils/workspaceWorktree'
import { isCanceledSprintEngineRun, isCompletedSprintEngineRun } from '../../utils/sprintengine'
import { refreshSprintEngineWorkspaceProjection } from '../../utils/sprintengineProjectionRefresh'
import { publishDiagnostic } from '../../utils/diagnostics'
import { sortWorkspacesByUserMessage } from '../../utils/workspaceRecency'
import { isHiddenFromRail } from '../../utils/workspaceVisibility'
import { isSettledWorkspace, workspaceLastActiveAt } from '../../utils/workspaceSettle'
import { workspaceRowEmphasis } from '../../utils/workspaceRowEmphasis'

type Activity = 'working' | 'failed' | 'needs-input' | 'idle'

type TerminalRecency = {
  hasRunning: boolean
  idleSince: number | null
  lastInputAt: number | null
  // When the current turn started, for the row's working counter. Null whenever
  // nothing in the workspace is working.
  workingSince: number | null
}

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
  // Workspaces whose agents are resident (live PTY) right now — instant to
  // switch into, versus suspended/exited rows that re-launch on open. Said in
  // words on the row for a screen reader; it is no longer what bolds a row
  // (see `workspaceRowEmphasis`), because a live pty on a chat nobody has
  // touched since this morning is not the same claim as a chat in motion.
  residentWorkspaceIds: Set<WorkspaceId>
  terminalRecencyByWorkspaceId: Record<WorkspaceId, TerminalRecency>
  // The unseen-completion marks, as they change — the app rail's Home badge
  // counts them (useRailBadges). The sidebar stays their owner: it is the layer
  // that knows what was looked at, and nothing outside it writes a mark.
  onUnseenDoneChange?: (ids: ReadonlySet<WorkspaceId>) => void
  onSelectWorkspace: (id: WorkspaceId) => void
  // Open a session that lives on a paired machine (the Remote band): focus
  // the workspace here that already is it, or attach a new one. Absent in a
  // host with no fleet (partial harnesses); the band then draws its rows
  // and opens nothing.
  onOpenRemoteSession?: (spec: RemoteSessionOpenSpec) => void
  onMoveWorkspaceToNewWindow: (id: WorkspaceId, placement?: WorkspaceDetachPlacement) => void
  onMoveWorkspaceToMainWindow: (id: WorkspaceId) => void
  onCloseWorkspace: (id: WorkspaceId) => void
  onDeleteWorkspaceWithState: (id: WorkspaceId) => Promise<void> | void
  onForgetFolder: (folderPath: string) => void
  // Open the pre-creation New Chat panel scoped to the active workspace's
  // folder — the create control. The one way in (owner, 2026-09-04): the split
  // "New…" half and its create menu (Workspace / Sprint / the retired task
  // board) are gone with the New workspace hub; sprints start from the
  // Sprints door.
  onNewChat: () => void
  // Scope a new chat to a specific project folder (workspace-row context menu).
  // The panel owns the agent/engine choice — the sidebar only opens it.
  onNewChatInFolder: (folderPath: string) => void
  onRevealFolder: (folderPath: string) => void
  onSetSidebarCollapsed: (collapsed: boolean) => void
  // Persisted expanded width (px) and its setter, for drag-to-resize.
  sidebarWidth: number
  onSetSidebarWidth: (width: number) => void
}

type FolderGroup = {
  key: string
  displayName: string
  fullPath: string | null
  missing: boolean
  workspaces: Workspace[]
  // A header for chats born on a paired machine (remote-sessions-ux /
  // new-chat-on-a-remote-machine): the machine plus the remote workspace's
  // root. Epic decision 6 puts project identity on the folder header, and a
  // remote row's project is on another machine — so the header names both,
  // rather than filing the row under "No folder". Null for every local group.
  remote: { machineName: string; workspaceRoot: string | null } | null
}

const NULL_FOLDER_KEY = '__no_folder__'

// The flat stream's single Settled shelf (all-chats-view). It shares the fold
// map with the folders' shelves — one place remembers what is open — under a
// key no folder can produce.
const ALL_CHATS_SHELF_KEY = '__all_chats__'
const ALL_CHATS_SHELF_ID = 'ws-settled-all-chats'

/**
 * The header facts a merged group takes from its local folder (the row that
 * founds the group may be the remote one, which has no folder of its own).
 */
export type LocalGroupHeader = { key: string; folderPath: string; missing: boolean }

function resolveGroups(
  workspaces: readonly Workspace[],
  identities: FolderIdentityMap
): { keys: Map<string, string>; headers: Map<string, LocalGroupHeader> } {
  // The local twin per repository, chosen by a rule that does not move when
  // rows are reordered or a chat is added: a plain checkout over a worktree
  // (a worktree shares its checkout's remote, and is its own header), then
  // the lexically first folder. Otherwise a remote row hopped between the
  // two headers on unrelated actions.
  const localByIdentity = new Map<string, { key: string; folder: string; worktree: boolean }>()
  const keys = new Map<string, string>()
  for (const workspace of workspaces) {
    const key = groupKeyOf(workspace)
    keys.set(workspace.id, key)
    const folder = workspace.folderPath?.trim()
    if (!folder || workspace.remoteOrigin) continue
    const identity = identities.get(folderIdentityKey(folder))
    if (!identity?.canonicalKey) continue
    const candidate = {
      key,
      // The group's key, not the row's own folder: a worktree row already
      // files under its parent, so that is the header a remote twin would
      // be joining if this row were the pick.
      folder: key,
      worktree: Boolean(workspace.worktree) || ownFolderKeyOf(workspace) !== key,
    }
    const current = localByIdentity.get(identity.canonicalKey)
    const better =
      !current
      || (current.worktree && !candidate.worktree)
      || (current.worktree === candidate.worktree && candidate.folder < current.folder)
    if (better) localByIdentity.set(identity.canonicalKey, candidate)
  }
  for (const workspace of workspaces) {
    const repository = workspace.remoteOrigin?.repository
    if (!repository?.canonicalKey) continue
    const local = localByIdentity.get(repository.canonicalKey)
    if (local) keys.set(workspace.id, local.key)
  }
  // Two passes, because a header is a folder's own statement first. A row
  // that IS the folder speaks for it — path and missing-ness both — so a
  // plain workspace of the project always wins the header over a worktree
  // filed under it.
  const headers = new Map<string, LocalGroupHeader>()
  for (const workspace of workspaces) {
    const key = keys.get(workspace.id) ?? groupKeyOf(workspace)
    const folderPath = workspace.folderPath?.trim()
    if (workspace.remoteOrigin || !folderPath || headers.has(key)) continue
    if (ownFolderKeyOf(workspace) !== key) continue
    headers.set(key, { key, folderPath, missing: workspace.folderMissing === true })
  }
  // Then the keys nobody spoke for: a worktree chat whose parent project is
  // not itself open. The header is still the parent's — its name and its
  // full path — and never missing, since no row here has looked at it.
  for (const workspace of workspaces) {
    const key = keys.get(workspace.id) ?? groupKeyOf(workspace)
    if (workspace.remoteOrigin || headers.has(key)) continue
    const folderPath = workspaceProjectRoot(workspace)
    if (!folderPath) continue
    headers.set(key, { key, folderPath, missing: false })
  }
  return { keys, headers }
}


const DRAG_MIME_WORKSPACE = 'application/x-multicode-workspace'
const DRAG_MIME_FOLDER = 'application/x-multicode-folder'

function normalizeFolder(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '')
}

// A folder of nothing but whitespace is no folder at all, and has to be no
// folder to EVERY reader: `workspaceProjectRoot` already trims it away, so a
// key that kept it would file the row under a header spelled "   " while the
// project it hands to New chat is null.
function folderKey(value: string | null): string {
  if (!value?.trim()) return NULL_FOLDER_KEY
  return normalizeFolder(value).toLowerCase()
}

function folderDisplayName(value: string | null): string {
  if (!value?.trim()) return 'No folder'
  const normalized = normalizeFolder(value)
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return normalized
  return normalized.slice(lastSlash + 1) || normalized
}

/**
 * Which header a row files under. Local rows group by folder exactly as they
 * always have; a remote-born row (`workspace.remoteOrigin`, the durable
 * provenance record — the mark rides the workspace, not a live pane, so
 * closing the pane never loses it) groups by the machine
 * and the remote workspace, never under "No folder". A legacy remote row —
 * no `remoteOrigin`, no folder, but fleet panes in its layout — groups by
 * the machine its layout names.
 *
 * A worktree-backed row files under the project it was cut from, not under
 * its own checkout: the person branched one project, they did not open a
 * second one, and a header named after the slug says otherwise. The row says
 * it is a worktree on its own line instead.
 */
export function groupKeyOf(workspace: Workspace): string {
  const origin = workspace.remoteOrigin
  if (origin) return `remote:${origin.connectionId}:${origin.workspaceId}`
  if (!workspace.folderPath) {
    const [machine] = fleetMachineNamesOf(workspace)
    if (machine) return `remote:${machine.toLowerCase()}`
  }
  return folderKey(workspaceProjectRoot(workspace))
}

/**
 * The key this row's own folder makes, before regrouping — the answer to
 * "did this row found its own group?", which `groupKeyOf` can no longer give
 * now that a worktree row is deliberately filed elsewhere.
 */
function ownFolderKeyOf(workspace: Workspace): string {
  return folderKey(workspace.folderPath)
}

/**
 * Where "New chat in project" lands from this row, and null when there is
 * nowhere live to land it. The project is the header the row files under —
 * for a worktree row, the checkout it was cut from — so a worktree pruned
 * from under a chat does not take the action away: what went missing is the
 * worktree, not the project. Only a row whose target IS its own folder is
 * stopped by that folder being gone; a parent's own state is the header's to
 * report, and a header synthesized from a worktree never reports missing.
 */
function newChatProjectTarget(workspace: Workspace): string | null {
  const own = workspace.folderPath?.trim()
  if (!own) return null
  const target = workspaceProjectRoot(workspace) ?? own
  if (folderKey(target) === ownFolderKeyOf(workspace)) return workspace.folderMissing ? null : target
  return target
}

function remoteGroupOf(workspace: Workspace): FolderGroup['remote'] {
  const origin = workspace.remoteOrigin
  if (origin) return { machineName: origin.machineName, workspaceRoot: origin.workspaceRoot }
  if (!workspace.folderPath) {
    const [machine] = fleetMachineNamesOf(workspace)
    if (machine) return { machineName: machine, workspaceRoot: null }
  }
  return null
}

function remoteGroupDisplayName(workspace: Workspace): string {
  const origin = workspace.remoteOrigin
  if (origin) {
    const project = origin.workspaceName || folderDisplayName(origin.workspaceRoot)
    return `${origin.machineName} · ${project}`
  }
  return fleetMachineNamesOf(workspace)[0] ?? 'No folder'
}

function buildFolderGroups(
  workspaces: Workspace[],
  keyOf: (workspace: Workspace) => string = groupKeyOf,
  headers: ReadonlyMap<string, LocalGroupHeader> = new Map()
): FolderGroup[] {
  const groupOrder: string[] = []
  const groups = new Map<string, FolderGroup>()

  for (const workspace of workspaces) {
    const key = keyOf(workspace)
    if (!groups.has(key)) {
      groupOrder.push(key)
      // A row that is not itself the folder — a remote row filed under a
      // local one, a worktree filed under its project — never founds the
      // group with a header of its own: the header is the project's, read
      // off the header map whatever row happens to come first in the list.
      const merged = key !== ownFolderKeyOf(workspace) ? headers.get(key) ?? null : null
      const remote = merged ? null : remoteGroupOf(workspace)
      // Trimmed for the same reason `folderKey` trims: whatever the key
      // called "no folder" must not reappear as a header path made of spaces.
      const folderPath = merged ? merged.folderPath : workspace.folderPath?.trim() || null
      groups.set(key, {
        key,
        displayName: remote ? remoteGroupDisplayName(workspace) : folderDisplayName(folderPath),
        // A remote group has no LOCAL path: nothing here may reveal, forget,
        // or create into a folder that lives on another machine.
        fullPath: remote ? null : folderPath,
        missing: remote ? false : merged ? merged.missing : workspace.folderMissing === true,
        workspaces: [],
        remote,
      })
    }
    const group = groups.get(key)!
    group.workspaces.push(workspace)
    // Only a row that IS the folder may report it gone. A pruned worktree is
    // its own folder's loss, not the project's, and painting the project
    // missing would also take away the header's New chat and Reveal.
    if (workspace.folderMissing && !group.remote && ownFolderKeyOf(workspace) === key) group.missing = true
  }

  return groupOrder.map((key) => groups.get(key)!)
}

// No `shadow` member: the row's edge is not an accent's to carry. Selection's
// 2px accent edge is drawn once by `SELECTION_EDGE_CLASS` below, on top of
// whatever fill the row has — a neutral one, a highlight hue, or a status wash
// — so no accent needs to ship an edge of its own.
type RowAccent = {
  bg: string
  text: string
}

// Selection's edge: the 2px accent border the row of the pane you are driving
// wears (owner ruling 2026-09-05; design-system/patterns/selection.html and
// components/list-row).
//
// The complaint it answers, verbatim: "I'm finding it a little bit difficult to
// really see which terminal I'm in control of." The selected row was a neutral
// fill and an ink lift, which is one step of grey; the rows around it wearing
// `needs-input` gold or `unseen-done` green were a hue, a whole-row wash AND a
// ring. The loudest row on the rail was reliably not the one the person was in,
// and the green ring in particular read as "you are here" because it is the
// same mark the FOCUSED TERMINAL wears (`terminal-focus-ring`, a 2px
// --border-focus border). So the two vocabularies are now split down the
// middle: a tint says what happened on a row, an edge says which row you are
// in, and the rail and the terminal it drives wear that edge together.
//
// `--selection-edge` rather than `--accent-primary` directly: the resting-tier
// rules in assets/index.css rebind it to `transparent` on a pane that is not
// holding focus, the same way they rebind the fill and the ink lift. Naming the
// accent here would opt the sidebar out of tiering.
const SELECTION_EDGE_CLASS = 'ring-2 ring-inset ring-[color:var(--selection-edge)]'

// No `glyph` member either, and no per-mode entry left to hold one: the row
// carries no icon since 2026-09-02 (the logo moved to the folder header, the
// type glyph went), and the glyph ink was the ONLY thing the mode accents ever
// differed by — every mode's fill and ink were already identical. So one
// accent stands for every mode.
//
// The active row body sits on the brighter `--bg-selected` surface — the same
// canonical selection fill used elsewhere (notifications, file/artifact
// selection) — so the selected row clears the hover `--bg-surface-raised` fill
// by a full step.
//
// The colored 4px left rail is gone: selection is a neutral fill and carries no
// left bar (`design-system/patterns/selection.html`). A collapsed icon rail is
// the one place the design system still permits a stripe — rows there are too
// narrow for a fill to read — but this sidebar has no such rail to except:
// collapsing hides the whole aside rather than narrowing it to icons (the
// `hidden` class on the <aside> below), so no stripe survives here.
const SELECTED_ROW_ACCENT: RowAccent = {
  bg: 'bg-[color:var(--bg-selected)]',
  text: 'text-[color:var(--text-strong)]',
}

// Effective accent for a workspace row: a user-set highlight colour when the
// workspace has one, the neutral selection accent otherwise. Mode no longer
// enters into it — with the row's icon gone there is nothing per-mode left to
// tint, so the enablement gating this used to do (degrade a disabled module's
// row to the generic accent) has nothing to degrade.
export function rowAccent(workspace: Workspace): RowAccent {
  const highlight = workspace.highlight?.color
  if (highlight) {
    const swatch = getHighlightSwatch(highlight)
    return { bg: swatch.bg, text: swatch.text }
  }
  return SELECTED_ROW_ACCENT
}

// A user-set highlight colour is workspace identity, not selection, so its rail
// reads the same whether or not the row is the active one. Rows with no
// highlight keep the base transparent 4px border and show no rail at all.
function highlightRailClass(workspace: Workspace): string {
  if (!hasHighlightOverride(workspace.highlight)) return ''
  return `border-l-[4px] ${getHighlightSwatch(workspace.highlight!.color!).border}`
}

// The selected row is its fill, its ink lift and the selection edge — no left
// bar of its own. The base row keeps `border-l-[4px] border-l-transparent`, so
// a highlight rail appears and disappears without shifting the row's content
// sideways, and the edge is a ring so it never moves the row either.
function activeRowClass(workspace: Workspace): string {
  const accent = rowAccent(workspace)
  return `${highlightRailClass(workspace)} ${accent.bg} ${accent.text} ${SELECTION_EDGE_CLASS}`
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
  position: 'before' | 'after',
  keyOf: (workspace: Workspace) => string = groupKeyOf
): WorkspaceId[] {
  const groups = buildFolderGroups(workspaces, keyOf)
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

// The Settled shelf's fold row (settled-chats, 2026-09-07): the one line a
// folder shows for its resting chats — "Settled", and how many — collapsed by
// default, in the fold-row idiom the older-rows disclosure used to carry. The
// section rule applies (design-system/components/section): a heading earns
// its place by separating one group from another, so the row renders only
// when the folder has settled rows to separate from its active ones.
function SettledShelfRow({
  count,
  expanded,
  controlsId,
  onToggle,
  flush = false,
}: {
  count: number
  expanded: boolean
  controlsId: string
  onToggle: () => void
  /** The flat stream's shelf: no folder header above it, so no indent under one. */
  flush?: boolean
}) {
  return (
    <div className="mx-1.5 my-0.5 flex items-center gap-1">
      {/* The kit's nav row. Only the alignment inset stays with the caller —
          a `pl-*` out-specifies the density's `px-2` in Tailwind's own
          ordering — along with the type step, which `RowButton` deliberately
          does not spell. */}
      <RowButton
        density="nav"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={controlsId}
        // design-tokens-allow: alignment — 30px = the workspace row's 4px rail + 26px inset, so the fold row's text lines up under the row title (see the layout note in this file); flush drops to 10px, which is the same sum for a flat-stream row
        className={`min-w-0 flex-1 select-none ${flush ? 'pl-[10px]' : 'pl-[30px]'} pr-1.5 text-meta`}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className={`icon-xs shrink-0 text-[color:var(--text-disabled)] transition-transform ${
            expanded ? '' : '-rotate-90'
          }`}
        >
          <path d="M5 6L8 9L11 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="truncate">Settled</span>
        <span className="tabular-nums text-[color:var(--text-subtle)]">{count}</span>
      </RowButton>
    </div>
  )
}

/**
 * The panes this workspace's layout mounts FROM other machines: one entry per
 * fleet-terminal tab, with the machine it names and the CLI mark if the tab
 * carries one. The layout JSON is the one durable record of a remote
 * attachment, so a walk of it — not a live socket — is what says a workspace
 * is remote-flavoured even while the peer sleeps. Each pane is an open
 * terminal for the row's head stack, exactly as a local live session is.
 */
/**
 * The open terminals a row shows as heads, and the one liveness test the row
 * has (the-diff-an-agent-made, decision 9): the local sessions whose process is
 * alive, plus the fleet panes the layout mounts from other machines. A
 * suspended or exited local session is not open — `isLiveTerminal` is the
 * filter the caller applies before building the map — so a chat whose agent
 * has been parked has no heads, no line 2, and no git facts.
 */
export function rowOpenTerminals(
  workspace: Workspace,
  liveSessionsByWorkspaceId: ReadonlyMap<string, ReadonlyArray<{ sessionId: string; cli?: string }>>
): Array<{ sessionId: string; cli?: string; remote?: boolean }> {
  return [
    ...(liveSessionsByWorkspaceId.get(workspace.id) ?? []).map((session) => ({
      sessionId: session.sessionId,
      ...(session.cli ? { cli: session.cli } : {}),
    })),
    ...fleetPanesOf(workspace).map((pane) => ({
      sessionId: pane.tabId,
      ...(pane.cli ? { cli: pane.cli } : {}),
      remote: true,
    })),
  ]
}

/** Whether a row has any open terminal at all — the gate on its second line and its git poll. */
export function rowHasOpenTerminals(
  workspace: Workspace,
  liveSessionsByWorkspaceId: ReadonlyMap<string, ReadonlyArray<unknown>>
): boolean {
  return (liveSessionsByWorkspaceId.get(workspace.id)?.length ?? 0) > 0 || fleetPanesOf(workspace).length > 0
}

export function fleetPanesOf(workspace: Workspace): Array<{ tabId: string; machineName: string; cli?: string }> {
  const panes: Array<{ tabId: string; machineName: string; cli?: string }> = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const record = node as { type?: unknown; id?: unknown; component?: unknown; config?: unknown; children?: unknown }
    if (record.type === 'tab' && record.component === 'fleet-terminal') {
      const config = record.config as { machineName?: unknown; cli?: unknown; remoteSessionId?: unknown } | undefined
      const machine = config?.machineName
      if (typeof machine === 'string' && machine) {
        const tabId =
          typeof record.id === 'string' && record.id
            ? record.id
            : `fleet-terminal:${machine}:${String(config?.remoteSessionId ?? panes.length)}`
        panes.push({
          tabId,
          machineName: machine,
          ...(typeof config?.cli === 'string' && config.cli ? { cli: config.cli } : {}),
        })
      }
    }
    if (Array.isArray(record.children)) for (const child of record.children) walk(child)
  }
  const model = workspace.layoutModel as { layout?: unknown; borders?: unknown } | undefined
  walk(model?.layout)
  if (Array.isArray(model?.borders)) for (const border of model.borders) walk(border)
  return panes
}

/** The unique machine names of the workspace's fleet panes, in layout order. */
export function fleetMachineNamesOf(workspace: Workspace): string[] {
  return [...new Set(fleetPanesOf(workspace).map((pane) => pane.machineName))]
}

/**
 * The machines a row says it lives on. `remoteOrigin` is the primary source —
 * set once at creation and kept when the pane closes — and the layout walk is
 * the fallback for rows that predate it, plus any machine a local workspace
 * has since mounted a pane from. Local is the unmarked default (decision 7).
 */
export function provenanceMachinesOf(workspace: Workspace): string[] {
  const names = new Set<string>()
  if (workspace.remoteOrigin) names.add(workspace.remoteOrigin.machineName)
  for (const name of fleetMachineNamesOf(workspace)) names.add(name)
  return [...names]
}

/**
 * The unseen-completion mark — a "Done" pill on the row, drawn by
 * `doneRowClass`: which workspaces finished a turn while the person was
 * looking elsewhere, and have not been opened since.
 *
 * Sourced ONLY from hook-authoritative activity ([[agent-state-hooks-only]]):
 * `workingSince` is `deriveWorkspaceWorkingSince` — the clock the row's
 * working counter already trusts, non-null only while hooks say a turn is in
 * flight. A turn is DONE when that clock stops on a workspace that still has a
 * hook-settled session (`settledWorkspaceIds`): a process that was killed
 * mid-turn also stops the clock, and it did not finish anything. Opening the
 * workspace clears its mark, and so does going back to work — a parked model
 * that its background agent re-invoked is not finished, and earns the mark
 * again when that turn ends. The active workspace never earns one — the
 * person is watching. Pure, so the sidebar's effect stays a one-liner.
 */
function deriveUnseenCompletions(input: {
  previous: ReadonlySet<string>
  workingSinceBefore: Readonly<Record<string, number | null | undefined>>
  workingSinceNow: Readonly<Record<string, number | null | undefined>>
  settledWorkspaceIds: ReadonlySet<string>
  activeWorkspaceId: string | null
}): Set<string> {
  const next = new Set<string>()
  for (const id of input.previous) {
    if (id === input.activeWorkspaceId) continue
    if (!(id in input.workingSinceNow)) continue
    if (typeof input.workingSinceNow[id] === 'number') continue
    next.add(id)
  }
  for (const id of Object.keys(input.workingSinceNow)) {
    const before = input.workingSinceBefore[id]
    const now = input.workingSinceNow[id]
    const stopped = typeof before === 'number' && typeof now !== 'number'
    if (!stopped) continue
    if (id === input.activeWorkspaceId) continue
    if (!input.settledWorkspaceIds.has(id)) continue
    next.add(id)
  }
  return next
}

/** A live session whose hooks report a settled phase: the turn ended, the agent is still there. */
function isHookSettledSession(session: { processAlive: boolean; agentState?: { phase: string; source: string } }): boolean {
  if (!session.processAlive) return false
  const state = session.agentState
  if (!state || state.source !== 'hook') return false
  return state.phase === 'idle' || state.phase === 'awaiting_input'
}

// Needs-input is the loudest thing a row can say, so it takes the row's whole
// surface rather than a 6px dot in its corner (owner ruling 2026-09-04): a gold
// tint and the title in warn ink. The dot is gone with it — status-dot's own
// spec calls a dot beside a surface already saying the same thing a
// reject-on-sight, and a dot is the weakest possible carrier for the one state
// that actually wants you to look.
//
// The gold RING that used to close the tint is gone too (owner ruling
// 2026-09-05). The edge belongs to selection now, and a status state may not
// borrow it: while both drew edges, the loudest row on the rail was whichever
// one had a status, never the one the person was actually in. A tint says what
// happened here; the edge says where you are. A row that is both wears the wash
// and, from `activeRowClass`, the accent edge — two marks answering two
// questions instead of two spellings of one.
//
// A left rail was never on the table for either: a tone-coloured left bar is a
// ruled rejection in this system (designSystemAxes' LEFT_TONE_BAR), and the 4px
// left slot already belongs to a different vocabulary here — the user's
// highlight colour, which is identity rather than severity.
function attentionRowClass(active: boolean): string {
  return [
    'bg-[color:var(--tone-warn-soft)] hover:bg-[color:var(--tone-warn-soft)]',
    // The wash is the same either way: what changes when the row is the active
    // one is the accent edge, and that is selection's to add, not status's.
    active ? SELECTION_EDGE_CLASS : '',
    'text-[color:var(--tone-warn-on-tint)]',
  ]
    .filter(Boolean)
    .join(' ')
}

// The unseen-done row is the same treatment in the good tone (owner ruling
// 2026-09-04, replacing the bordered "Done" micro chip): a green fill, the
// title in good ink, and the same one-shot flash on arrival — list-row's
// `--finished`. One notch under the gold by construction (owner, same day: the
// first cut at full strength read heavy): the fill is the 10% wash rather than
// the 18% soft. It holds until the row is opened — `deriveUnseenCompletions`
// clears the mark the moment the workspace becomes the active one — so the
// surface, not a word in the corner, is what says "finished while you were
// away". A chip was the wrong carrier for the same reason the dot was for
// needs-input: the one state that wants you to come back was the quietest
// thing on the row. Needs-input still outranks it — a row that is both draws
// gold, because that one needs an answer rather than a look.
//
// The green ring this used to close with is gone (owner ruling 2026-09-05).
// It was the single worst offender in the whole rail: a 2px green border around
// a row is EXACTLY the mark the focused terminal wears, so the row that had
// finished while you were away was the one row on screen that looked like the
// one you were typing into. The wash stays; the edge went to selection.
//
// Exported for the row-meta suite, which pins the good-tone channels.
function doneRowClass(active: boolean): string {
  return [
    'bg-[color:var(--tone-good-faint)] hover:bg-[color:var(--tone-good-faint)]',
    active ? SELECTION_EDGE_CLASS : '',
    'text-[color:var(--tone-good-on-tint)]',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * The one-shot flash a row plays when it STARTS needing you (`warn`), or when
 * a turn on it has just finished while you were elsewhere (`good`).
 *
 * Motion here means "just changed" — the other of the two things this system
 * lets motion mean — and then it stops. What holds the row loud while it waits
 * is ink: the gold fill, rail and title. An ambient shimmer was considered and
 * ruled out (owner, 2026-09-04): `components/liveness` is explicit that motion
 * is not emphasis and that a mark which is always moving stops meaning
 * anything, and three waiting rows would have been three loops running beside
 * the terminals.
 *
 * It renders as a keyed, pointer-inert sibling rather than on the row itself,
 * so replaying the animation never remounts a row mid-drag or steals its focus.
 * `mode: 'increase'` fires on the way in only; `resetKey` keeps a row that
 * merely swaps identity from flashing.
 */
export function AttentionPulse({
  active,
  resetKey,
  tone = 'warn',
}: {
  active: boolean
  resetKey: string
  /** The status colour the row is already wearing; the flash never introduces its own. */
  tone?: 'warn' | 'good'
}) {
  const token = useChangePulse(active ? 1 : 0, { mode: 'increase', resetKey })
  if (token === 0) return null
  return (
    <span
      key={token}
      aria-hidden="true"
      className={`attention-row-pulse ${tone === 'good' ? 'attention-row-pulse-good' : ''} pointer-events-none absolute inset-0 rounded-md`}
    />
  )
}

/**
 * How long the turn in flight has been running, beside the working dots (owner
 * direction 2026-09-04): the dots say work
 * is ongoing, this says for how long. The word is dropped — the dots already
 * carry it and the aria-label spells it out — because a 276px rail has no room
 * to repeat itself.
 *
 * It owns its own tick rather than riding the sidebar's shared `useRelativeNow`:
 * that runs at 30s and so cannot count seconds, and dropping IT to 1s would
 * re-render the whole tree once a second. Here one text node re-renders, and the
 * tick relaxes to 30s once the turn is past a minute and the seconds stop
 * mattering.
 */
/**
 * The mark a band row leads with (owner ruling 2026-09-05): the machine
 * glyph, and the machine's name only on hover. The band has no machine lines,
 * so this is the one place a row says where it lives — and it says it in the
 * tooltip and the accessible name, not in the row's own width.
 */
function RemoteRowGlyph({ machineName }: { machineName: string }) {
  const short = shortMachineName(machineName)
  return (
    <Tooltip content={`On ${short}`} placement="bottom" wrapperClassName="flex shrink-0 items-center">
      <span role="img" aria-label={`On ${short}`} className="flex shrink-0 items-center" data-remote-row-glyph={machineName}>
        <RemoteMachineGlyph className="icon-xs shrink-0 text-[color:var(--text-muted)]" />
      </span>
    </Tooltip>
  )
}

export function WorkingElapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  const withinFirstMinute = now - since < 60_000
  useEffect(() => {
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), withinFirstMinute ? 1_000 : 30_000)
    return () => window.clearInterval(id)
  }, [since, withinFirstMinute])
  const text = formatElapsedMs(since, now)
  if (!text) return null
  return (
    // Accent ink, matching the dots it sits beside, so the pair reads as one
    // status token rather than a mark plus an unrelated number. No aria-label
    // on a generic span (ignored there — the row's own review): the number is
    // the visible text and an sr-only sentence says what it measures.
    <span className="tabular-nums text-[color:var(--accent-primary)]">
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">Working for {text}</span>
    </span>
  )
}

/**
 * The branch a row or a line sits on: the glyph, the name, and the path on
 * hover. Shared by a terminal's line and by a parked worktree row, so the two
 * are the same chip and not two drawings of one idea that drift apart.
 *
 * A worktree reads at full strength — it is a checkout of its own, not one it
 * shares — and says so in words too, since weight alone carries no meaning.
 */
function BranchChip({
  branch,
  worktree,
  cwd,
  dim = false,
}: {
  branch: string
  worktree: boolean
  cwd: string | null
  /** The row is background: nothing on its meta line may outshine its title. */
  dim?: boolean
}) {
  return (
    <Tooltip
      content={cwd ? (worktree ? `Worktree · ${cwd}` : cwd) : worktree ? 'A worktree of its own' : `On ${branch}`}
      wrapperClassName="flex min-w-[4ch] shrink-[3] items-center"
    >
      <span
        className={`flex min-w-0 items-center gap-1 font-mono text-micro ${
          // A worktree of the terminal's own reads at full strength: it is
          // this terminal's checkout, not a checkout it shares. Not on a
          // background row, though — full strength there is BRIGHTER than the
          // dimmed title above it, which reads as the branch being the point
          // of a chat nobody is using (owner, 2026-09-07). It inherits the
          // line's ink instead.
          worktree && !dim ? 'text-[color:var(--text-default)]' : ''
        }`}
      >
        <GitBranchGlyph className="icon-xs shrink-0" />
        <TruncatedText as="span" text={branch} className="min-w-0" />
        {worktree ? <span className="sr-only"> (worktree)</span> : null}
      </span>
    </Tooltip>
  )
}

/**
 * One terminal's line under a row's title (sidebar-lists-every-terminal):
 * mark · branch · ±lines · seat. The row shows one per live terminal in
 * place of the head pile and the single row-level branch it used to carry:
 * the lines are the count, and each says where IT is — an agent in a
 * worktree of its own reads at full strength, with the path on hover.
 *
 * The terminal's NAME is not row text: it is the mark's tooltip and
 * accessible name, so the line spends its width on where the terminal is and
 * what it changed rather than on a name the row's title already implies.
 *
 * Truncation is an ordered give-way, not a fixed cap: the branch yields
 * (weight 3) down to its floor; the mark, the diff and the seat never
 * shrink. The line clips at the row's gutter rather than spilling past it.
 *
 * `seatOverlay` is the row's hover-revealed actions, handed to the first
 * line only; the seat's own content steps aside for it on hover, as the
 * row-level seat always did.
 */
export function TerminalLineView({
  line,
  now,
  seatOverlay,
  disambiguate = false,
  dim = false,
  rowOwnsStatus = false,
  onOpenDiff,
}: {
  line: TerminalLine
  now: number
  seatOverlay?: React.ReactNode
  /** More than one line on the row: a waiting line wears the warn dot so the gold surface says WHICH. */
  disambiguate?: boolean
  /** The row is background (`workspaceRowEmphasis`): the line recedes with it. */
  dim?: boolean
  /**
   * The ROW is saying the status somewhere else — the flat stream's project
   * line, where the clock and the working dots sit at the top-right of every
   * row (all-chats-view). The line then says nothing about time or work: one
   * terminal's dots beside the row's own dots is the same fact twice, six
   * pixels apart (owner, 2026-09-07).
   *
   * What survives is the disambiguation mark, and only on a row with more than
   * one line: a row wearing the gold wash still has to say WHICH of its
   * terminals is the one waiting, and the row's single seat cannot.
   */
  rowOwnsStatus?: boolean
  /**
   * Open this terminal's diff — its agent's changelist (agent changelists).
   * Absent for a line with no agent behind it (a shell, a remote pane, a
   * session main holds no agent record for), and then the ±count is the plain
   * reading it has always been rather than a control that does nothing.
   */
  onOpenDiff?: () => void
}) {
  const runtimeLabel = line.cli
    ? labelForCliRuntime(line.cli as AgentCli)
    : line.kind === 'remote'
      ? 'Remote terminal'
      : 'Terminal'
  // The mark carries the terminal's name (owner ruling 2026-09-05), the way
  // the machine glyph below carries its machine's: the name is worth a hover,
  // not a column of row text spending the line's width on a word the row's
  // title already implies. A shell, whose name IS its runtime, says it once.
  const markLabel = line.name && line.name !== runtimeLabel ? `${line.name} · ${runtimeLabel}` : runtimeLabel
  const hasDiff = line.additions > 0 || line.deletions > 0
  // What the ±lines may claim, from the line's scope: the words on hover, the
  // words for a screen reader, and whether they step back. The sentences live
  // beside the scope they belong to (terminalLines), not in this render.
  const diffCopy = diffScopeCopy(line)
  const idleText = line.idleSince !== null ? formatRelativeMs(line.idleSince, now) : ''
  return (
    <div
      // Which terminal this line is, for the row's conversation peek: hovering
      // one of the row's own heads moves the open card to that terminal
      // (mockup frame 9). An attribute rather than a callback threaded down
      // through every line, because the peek reads it from one delegated
      // listener on the row — the line itself stays a presentational thing that
      // knows nothing about a hover surface. Agent lines only: a shell has no
      // conversation, and a remote pane's key is a tab id, not a session.
      {...(line.kind === 'agent' ? { 'data-peek-session': line.key } : {})}
      // The hover hook for the branch lookup (epic decision 8a): pointing at an
      // agent line asks main about its branch. Coalesced inside
      // `refreshPullRequestsForLine` — at most one ask per session per BRANCH
      // per minute, not one per mouse event — and on `mouseenter`, which does
      // not re-fire as the pointer crosses the line's own children.
      //
      // A line that already wears a mark asks too: decision 9 has main re-read
      // a reading older than ~60s on hover, and the lines with a reading to
      // refresh are exactly the lines that have a mark.
      onMouseEnter={
        shouldLookUpPullRequests(line) ? () => refreshPullRequestsForLine(line.key, line.branch) : undefined
      }
      className={`flex h-5 min-w-0 items-center gap-2 overflow-hidden text-meta ${
        dim ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-subtle)]'
      }`}
    >
      <Tooltip content={markLabel} placement="bottom" wrapperClassName="flex shrink-0 items-center">
        <span
          role="img"
          aria-label={markLabel}
          // The provider mark in the tab strip's vocabulary; a plain shell wears
          // the prompt mark, drawn, not typed, so it never needs type below the
          // 11px floor; a remote pane with no CLI wears the machine glyph.
          className="flex size-icon-sm shrink-0 items-center justify-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)]"
        >
          {line.cli ? (
            <CliIcon cli={line.cli} className="icon-xs" />
          ) : line.kind === 'remote' ? (
            <RemoteMachineGlyph className="icon-xs text-[color:var(--text-muted)]" />
          ) : (
            <svg viewBox="0 0 10 10" fill="none" aria-hidden="true" className="icon-xs text-[color:var(--text-muted)]">
              <path d="M2 2.5L4.5 5L2 7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5.8 8h2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          )}
        </span>
      </Tooltip>
      {line.machineName ? (
        // The glyph alone (owner ruling 2026-09-05): the machine's full name
        // is the tooltip's, not the line's.
        <Tooltip content={`On ${line.machineName}`} placement="bottom" wrapperClassName="flex shrink-0 items-center">
          <span role="img" aria-label={`Remote: ${line.machineName}`} className="flex shrink-0 items-center">
            <RemoteMachineGlyph className="icon-xs shrink-0" />
          </span>
        </Tooltip>
      ) : null}
      {line.branch ? (
        <BranchChip branch={line.branch} worktree={line.worktree} cwd={line.cwd} dim={dim} />
      ) : line.removed ? (
        <Tooltip content={line.cwd ? `Directory removed — ${line.cwd}` : 'Directory removed'} wrapperClassName="flex shrink-0 items-center">
          <span className="shrink-0 text-micro text-[color:var(--tone-error)]">Removed</span>
        </Tooltip>
      ) : null}
      {/* Immediately after the branch and before the ±lines, because it belongs
          to the branch: "this branch, this much changed, and here is where it
          went" (epic pull-request-marks, decision 4). It draws nothing at all
          when the conversation has no pull request, and the ±lines then slide
          left exactly as they always did — there is no "unknown" mark and no
          placeholder (decision 3). */}
      <PullRequestMark pullRequests={line.pullRequests} dim={dim} />
      {hasDiff ? (
        // Beside the branch, not at the far edge: for a git reading the two
        // are one fact — "this branch, this much changed" — and the trailing
        // seat is spoken for by the status. A `session` reading is a fact
        // about the AGENT rather than about the branch beside it, and keeps
        // the seat by layout convention alone; the words on hover and the
        // spoken label are what say which of the two you are reading. The
        // kit's Tooltip, not a native title, carries them.
        <Tooltip content={diffCopy.tooltip} wrapperClassName="inline-flex shrink-0">
          {/* Only a folder reading dims (see diffScopeCopy): a `branch` reading
              IS attributable work — to the branch rather than to this terminal
              alone — and a `session` reading is the most attributable of the
              four, this agent's own edits and nobody else's, so both draw at
              full strength.

              Where there is an agent behind the line the numbers are a
              CONTROL — the shortest path from "this agent changed 40 lines" to
              seeing which — and the kit's link button is what carries the focus
              ring and the hit target for it. Where there is not, the same
              drawing stays a reading. */}
          {onOpenDiff ? (
            <LinkButton
              layout="row"
              underline="never"
              size="inherit"
              ink="quiet"
              aria-label={`Open this agent\u2019s diff. ${diffCopy.srText}`}
              className={`shrink-0 font-mono text-micro tabular-nums ${diffCopy.dim ? 'opacity-60' : ''}`}
              onClick={(event) => {
                event.stopPropagation()
                onOpenDiff()
              }}
            >
              <span className="text-[color:var(--tone-good)]">+{line.additions}</span>
              <span className="ml-1 text-[color:var(--tone-error)]">−{line.deletions}</span>
            </LinkButton>
          ) : (
            <span
              className={`shrink-0 font-mono text-micro tabular-nums ${diffCopy.dim ? 'opacity-60' : ''}`}
            >
              <span className="text-[color:var(--tone-good)]">+{line.additions}</span>
              <span className="ml-1 text-[color:var(--tone-error)]">−{line.deletions}</span>
              <span className="sr-only">{diffCopy.srText}</span>
            </span>
          )}
        </Tooltip>
      ) : null}
      {/* The line's own seat: working dots + how long, the failure dot, a
          waiting mark when the row needs to say which line, else how long it
          has sat idle. The seat's min-w is what the row's revealed actions
          reserve (list-row's `data-actions` rule), so revealing never reflows. */}
      <span className="relative ml-auto flex h-5 min-w-[44px] shrink-0 items-center justify-end pl-2">
        <span
          className={`inline-flex items-center gap-1 ${
            seatOverlay ? 'transition-opacity group-hover:opacity-0 group-focus-within:opacity-0' : ''
          }`}
        >
          {rowOwnsStatus ? (
            // The row's own seat has said it. All that is left for the line is
            // the mark that says which terminal is waiting, on a row that has
            // more than one — and the words, always.
            line.needsInput ? (
              disambiguate ? (
                <StatusDot tone="warn" pulse label="Needs your input" />
              ) : (
                <span className="sr-only">Needs your input</span>
              )
            ) : null
          ) : line.working ? (
            <>
              <AgentWorkingDots label="Agent working" />
              {line.workingSince !== null ? <WorkingElapsed since={line.workingSince} /> : null}
            </>
          ) : line.failed ? (
            <StatusDot tone="error" label="Agent failed" />
          ) : line.needsInput ? (
            disambiguate ? (
              <StatusDot tone="warn" pulse label="Needs your input" />
            ) : (
              // The row's gold surface is the mark; a dot beside it would say
              // the same thing twice (status-dot's reject-on-sight).
              <span className="sr-only">Needs your input</span>
            )
          ) : idleText ? (
            <Tooltip content={`${line.idleLabel} ${formatRelativeMsAgo(line.idleSince!, now)} (${new Date(line.idleSince!).toLocaleString()})`}>
              <span className="text-meta tabular-nums text-[color:var(--text-subtle)]">
                <span aria-hidden="true">{idleText}</span>
                <span className="sr-only">{line.idleLabel} {formatRelativeMsAgo(line.idleSince!, now)}</span>
              </span>
            </Tooltip>
          ) : null}
        </span>
        {seatOverlay}
      </span>
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
  onUnseenDoneChange,
  onSelectWorkspace,
  onOpenRemoteSession,
  onMoveWorkspaceToNewWindow,
  onMoveWorkspaceToMainWindow,
  onCloseWorkspace,
  onDeleteWorkspaceWithState,
  onForgetFolder,
  onNewChat,
  onNewChatInFolder,
  onRevealFolder,
  onSetSidebarCollapsed,
  sidebarWidth,
  onSetSidebarWidth,
}: WorkspaceSidebarProps) {
  // Which of the app rail's sections this column shows. The tree stays mounted
  // and hidden under Extensions (its folds and scroll offset are the
  // operator's), and both step aside while a door's rail owns the column.
  const sidebarSection = useWorkspaceStore((s) => s.sidebarSection)
  const extensionsSection = sidebarSection === 'extensions'
  const homeHidden = extensionsSection || Boolean(contextRailActive)
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace)
  const reorderWorkspaces = useWorkspaceStore((s) => s.reorderWorkspaces)
  const setWorkspaceHighlight = useWorkspaceStore((s) => s.setWorkspaceHighlight)
  const setWorkspaceSettled = useWorkspaceStore((s) => s.setWorkspaceSettled)
  const clearWorkspaceHighlight = useWorkspaceStore((s) => s.clearWorkspaceHighlight)
  // The person changing a project's colour from its header menu; the only
  // writer besides the first-sight allocation (one-colour-per-project, 2026-09-09).
  const setProjectColor = useWorkspaceStore((s) => s.setProjectColor)
  const addWorkspaceFromStore = useWorkspaceStore((s) => s.addWorkspace)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  // A file on the conversation peek's changed-files list opens in the workspace
  // pane's Diff tab — the same tab, and the same focus, a Git panel row opens.
  const openPaneTab = useWorkspaceStore((s) => s.openPaneTab)
  const updateLayout = useWorkspaceStore((s) => s.updateLayout)
  const moveAgentToWorkspace = useWorkspaceStore((s) => s.moveAgentToWorkspace)
  const moveOpenFileToWorkspace = useWorkspaceStore((s) => s.moveOpenFileToWorkspace)
  // Passed to WorkspaceTypeIcon so a disabled-module workspace row degrades to
  // the generic glyph (AC4) instead of its tool icon.
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  // The two-line row's second line (remote-sessions-ux / two-line-session-rows):
  // live terminals grouped per workspace for the agent-head stack, and the slow
  // per-workspace git poll for branch + ±lines.
  const terminalSessions = useTerminalSessions()
  const sessionsByWorkspaceId = useMemo(() => {
    const map = new Map<string, typeof terminalSessions>()
    for (const session of terminalSessions) {
      if (!session.workspaceId || !isLiveTerminal(session)) continue
      const list = map.get(session.workspaceId)
      if (list) list.push(session)
      else map.set(session.workspaceId, [session])
    }
    return map
  }, [terminalSessions])
  // The same grouping WITHOUT the alive-process filter, for the conversation
  // peek alone. The map above is deliberately live-only — line 2 and the git
  // poll are about a checkout's current state, which a parked chat has no claim
  // on — but the peek asks the opposite question. "What was this one about?" is
  // asked most about the chat that is NOT running, and gating it on a living
  // process meant most of the sidebar after a restart offered no card at all.
  //
  // A suspended or exited session is still in main's list and still answers, so
  // it belongs here; a chat main has never heard of falls through to its own
  // agent records inside `rowConversationPeekIdentity`.
  const peekSessionsByWorkspaceId = useMemo(() => {
    const map = new Map<string, typeof terminalSessions>()
    for (const session of terminalSessions) {
      if (!session.workspaceId) continue
      const list = map.get(session.workspaceId)
      if (list) list.push(session)
      else map.set(session.workspaceId, [session])
    }
    return map
  }, [terminalSessions])
  // Owner ruling 2026-09-04 (the-diff-an-agent-made, decision 9): line 2 exists
  // only while the row has an open terminal. The git poll is therefore asked
  // about live rows alone — a suspended chat never reads a branch, so it can
  // never wear the checkout's current numbers as if they were its own, which
  // is exactly what every parked chat on `multicode` did after a restart. A
  // row that leaves this list drops out of the poll's membership and its
  // facts are pruned with it; a row that joins is swept on the next tick the
  // membership change triggers.
  const liveWorkspaces = useMemo(
    () => workspaces.filter((workspace) => rowHasOpenTerminals(workspace, sessionsByWorkspaceId)),
    [workspaces, sessionsByWorkspaceId]
  )
  // The poll asks about CHECKOUTS (sidebar-lists-every-terminal): the distinct
  // ones a live row's sessions sit on, keyed by path — two agents on one
  // checkout ask once, an agent in a worktree of its own asks for it, and a
  // move between them re-runs the sweep at once through the membership.
  const gitSummaryEntries = useMemo(() => {
    const paths = new Set<string>()
    for (const workspace of liveWorkspaces) {
      for (const path of checkoutPathsOf(workspace, sessionsByWorkspaceId.get(workspace.id) ?? [])) paths.add(path)
    }
    return [...paths].map((path) => ({ id: path, checkoutPath: path }))
  }, [liveWorkspaces, sessionsByWorkspaceId])
  const gitSummaries = useSidebarGitSummaries(gitSummaryEntries)
  // The unseen-completion mark (the green row, `doneRowClass`). Session-only: the
  // store's recency slice persists when a workspace was last TYPED into, not
  // when it was last looked at, so "seen" has no honest home there yet and a
  // restart simply starts clean. The transition is read off the same
  // hook-authoritative clock the working counter uses; nothing here reads a
  // pane. A ref carries the previous clocks so the effect compares, not
  // re-renders.
  const [unseenDoneIds, setUnseenDoneIds] = useState<Set<string>>(() => new Set())
  const workingSinceRef = useRef<Record<string, number | null>>({})
  useEffect(() => {
    const workingSinceNow: Record<string, number | null> = {}
    for (const [id, recency] of Object.entries(terminalRecencyByWorkspaceId)) {
      workingSinceNow[id] = recency.workingSince
    }
    const settledWorkspaceIds = new Set<string>()
    for (const session of terminalSessions) {
      if (session.workspaceId && isHookSettledSession(session)) settledWorkspaceIds.add(session.workspaceId)
    }
    const before = workingSinceRef.current
    workingSinceRef.current = workingSinceNow
    setUnseenDoneIds((previous) => {
      const next = deriveUnseenCompletions({
        previous,
        workingSinceBefore: before,
        workingSinceNow,
        settledWorkspaceIds,
        activeWorkspaceId,
      })
      if (next.size === previous.size && [...next].every((id) => previous.has(id))) return previous
      return next
    })
  }, [terminalRecencyByWorkspaceId, terminalSessions, activeWorkspaceId])
  useEffect(() => {
    onUnseenDoneChange?.(unseenDoneIds)
  }, [unseenDoneIds, onUnseenDoneChange])

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
  // Module-contributed top-nav doors used to be resolved here and handed to
  // ExtensionsRail. They are resolved inside `useExtensionsDrawerRows` now: the
  // memo here was keyed on module enablement alone, so a third-party module
  // that finished loading after boot never appeared in the drawer even though
  // the Extensions home — which uses the same resolver — listed it.
  const now = useRelativeNow()

  // A chat that has come to rest holds no terminals (owner ruling 2026-09-07).
  // Settling was presentation-only when the model landed — the row moved, the
  // ptys kept running — which left a folder's worth of shelved chats each
  // holding a live CLI process for as long as the app was up. Rest now means
  // rest: the ptys go with the row.
  //
  // Every settle goes through here — the hand gesture, the row menu, and the
  // sweep's three-idle-day decision — so the three cannot disagree about what
  // resting means.
  //
  // Gated on the row actually having something open, because the first sweep
  // after a restart settles hundreds of rows at once: without the gate each
  // one would fan out a kill per recorded agent session, and every one of
  // those is a no-op IPC round trip for a chat whose ptys died with the last
  // app run. Only a row with live sessions (or a mounted fleet pane) is worth
  // asking main about.
  //
  // Nothing here can kill a working agent: the sweep never settles a row that
  // is busy, held, or selected, and a hand Settle is the person saying so
  // about a chat they are looking at.
  const quietSettledWorkspace = useCallback(
    (id: WorkspaceId) => {
      const workspace = workspaces.find((candidate) => candidate.id === id)
      if (!workspace || !rowHasOpenTerminals(workspace, sessionsByWorkspaceId)) return
      void terminateWorkspaceTerminals(workspace)
    },
    [workspaces, sessionsByWorkspaceId]
  )

  // Settle by hand: the record first, then the ptys — the row must move even
  // if a kill fails, and `terminateWorkspaceTerminals` absorbs its failures.
  const settleWorkspaceById = useCallback(
    (id: WorkspaceId) => {
      setWorkspaceSettled(id, true)
      quietSettledWorkspace(id)
    },
    [setWorkspaceSettled, quietSettledWorkspace]
  )

  // The rest sweep (settled-chats, 2026-09-07): on the 30 s tick the idle
  // labels ride, and whenever an agent's activity flips — so a resting row
  // whose agent starts working wakes at once, not a tick later. This is the
  // one place that knows every blocker: what is working (activity, so it
  // wakes a resting row and holds an active one), and what wants the person
  // (a prompt, or the unseen finished mark — a thing to look at, which holds
  // a row out of the shelf and wakes one the sweep settled, never one the
  // person did). Not before main has listed the sessions once: until then
  // every row reads idle, and a chat parked at a prompt for days would settle
  // on the mount and wake a beat later. The store owns the rule and the
  // record; see `reconcileWorkspaceSettlement`.
  useEffect(() => {
    if (!hasTerminalSessionsSnapshot()) return
    const busyIds = new Set<WorkspaceId>()
    const heldIds = new Set<WorkspaceId>(unseenDoneIds)
    for (const [id, activity] of Object.entries(activityByWorkspaceId)) {
      if (activity === 'working') busyIds.add(id)
      else if (activity === 'needs-input') heldIds.add(id)
    }
    const settledNow = useWorkspaceStore.getState().reconcileWorkspaceSettlement({ now, busyIds, heldIds })
    for (const id of settledNow) quietSettledWorkspace(id)
  }, [now, activityByWorkspaceId, unseenDoneIds, terminalSessions, quietSettledWorkspace])

  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({})
  // Which folders have their Settled shelf open. Session-only and closed by
  // default: the shelf is where rows go to stop asking for attention.
  const [expandedSettledFolders, setExpandedSettledFolders] = useState<Record<string, boolean>>({})
  const [starredCollapsed, setStarredCollapsed] = useState(false)
  const [remoteCollapsed, setRemoteCollapsed] = useState(false)
  const [renamingId, setRenamingId] = useState<WorkspaceId | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [contextMenu, setContextMenu] = useState<{ workspaceId: WorkspaceId; x: number; y: number } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ folderKey: string; x: number; y: number } | null>(null)
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
    (event: React.KeyboardEvent<HTMLDivElement>, workspaceId: WorkspaceId | null, activate?: () => void) => {
      // Only the row itself steers the tree; keys from a focused child control
      // (rename input, row-action buttons) keep their own behavior.
      if (event.target !== event.currentTarget) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        // A Remote band row with no workspace here yet activates by attaching
        // (`activate`); every other row selects its workspace.
        if (activate) activate()
        else if (workspaceId) onSelectWorkspace(workspaceId)
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
      const startX = event.clientX
      const startWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth
      let collapsed = sidebarCollapsed
      dragWidthRef.current = startWidth
      setIsResizingSidebar(true)
      // The gesture is startColumnResizeDrag's, not this component's: a
      // maximised workspace pane covers the row this drag crosses, and a
      // browser tab in it is a `<webview>` guest that would swallow every
      // pointer event from the moment the pointer entered it.
      startColumnResizeDrag(event, {
        onDrag: (clientX) => {
          const outcome = resolveSidebarResize(startWidth + (clientX - startX))
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
        },
        onDragEnd: () => {
          // Commit the final width to the store exactly once (skipped if the drag
          // ended in the collapsed state, which already updated the store).
          const finalWidth = dragWidthRef.current
          dragWidthRef.current = null
          if (finalWidth !== null && !collapsed) onSetSidebarWidth(finalWidth)
          setIsResizingSidebar(false)
        },
      })
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
    | { kind: 'folder'; key: string }
    | null
  >(null)

  // Rail-hidden workspaces — the background Automations host and, since item
  // 1767, every sprint-run workspace — stay in the store and in window
  // assignments but never render as rail rows. Every presentation path below —
  // folder groups, starred — derives from this list, while drag-reorder still
  // stitches against the full `workspaces` array so a hidden workspace keeps its
  // place in the persisted order. Cross-workspace search now lives in the
  // global-search palette (T6), not a sidebar box.
  // Resting rows (`settledAt`, settled-chats 2026-09-07) stay in the rail:
  // each folder shows them in its Settled shelf (renderFolderBody), so a chat
  // that has come to rest is one glance away rather than gone.
  const railWorkspaces = useMemo(
    () => workspaces.filter((workspace) => !isHiddenFromRail(workspace)),
    [workspaces]
  )

  // Rows born on a paired machine (`workspace.remoteOrigin`) are the Remote
  // band's and only the band's (remote-sessions-in-the-sidebar, decision 1):
  // they never file under a folder header, so the folder groups are built
  // from the local rows alone. Starred stays additive — a starred remote row
  // appears there too, as a starred local row appears beside its folder.
  const localRailWorkspaces = useMemo(
    () => railWorkspaces.filter((workspace) => !workspace.remoteOrigin),
    [railWorkspaces]
  )

  // Repository identity per open local folder (one-project-across-machines),
  // read once per folder. It no longer moves rows between headers — the band
  // holds every remote row — but the reads stay: New chat's "Run on" is what
  // still keys on which repository a local folder is.
  //
  // Asked for the row's own folder AND the project it files under: a worktree row's
  // header is its parent checkout, which may have no row of its own, and the
  // project colour keyed on that header has to be able to ask which repository
  // it is (one-colour-per-project, 2026-09-09). Duplicates and nulls are the
  // hook's to drop.
  const folderIdentities = useFolderRepositoryIdentities(
    useMemo(
      () => localRailWorkspaces.flatMap((workspace) => [workspace.folderPath, workspaceProjectRoot(workspace)]),
      [localRailWorkspaces]
    )
  )
  // Resolved over the rail's rows, not every workspace: a local folder whose
  // rows are all hidden or archived is not a header a remote row can join.
  const resolvedGroups = useMemo(() => resolveGroups(localRailWorkspaces, folderIdentities), [localRailWorkspaces, folderIdentities])
  const keyOf = useCallback(
    (workspace: Workspace) => resolvedGroups.keys.get(workspace.id) ?? groupKeyOf(workspace),
    [resolvedGroups]
  )
  const groups = useMemo(
    () => buildFolderGroups(localRailWorkspaces, keyOf, resolvedGroups.headers),
    [localRailWorkspaces, keyOf, resolvedGroups]
  )

  // Which shape this rail lists chats in — the project tree, or one stream of
  // all of them (all-chats-view, 2026-09-07). Read from the store rather than
  // drilled through props: it is a persisted app-level preference, the way the
  // active door is, and every window shows the same shape.
  //
  // Read here, set in Settings → Appearance (owner, 2026-09-07). It rode over
  // the list for a day and was struck: a control the person touches once and
  // lives with does not deserve a permanent seat above the thing it arranges,
  // and the rail's one control at the top is New chat.
  const chatListView = useWorkspaceStore((s) => s.chatListView)

  const groupByKey = useMemo(() => {
    const map = new Map<string, FolderGroup>()
    for (const group of groups) map.set(group.key, group)
    return map
  }, [groups])
  // ─── One colour per project, worn on the folder glyph ──────────────────
  //
  // Owner review 2026-09-09 (backlog/unfiled/2026-09-09-one-colour-per-project
  // -on-the-folder-glyph.md): "it's easy to get confused and mixed up ... make
  // that folder icon a different colour". With a dozen chats open, "which repo
  // is this row?" is answered by reading the folder name every time; a hue on
  // the glyph answers it before the name is read.
  //
  // THE GLYPH AND NOTHING ELSE ON THE ROW. Not a tinted pill, not a dot, not
  // the project's name in colour — the design system's "identity colour"
  // clause: a glyph may wear an identity hue only where nothing else on the row
  // is coloured, and the hue identifies, it never grades. This rail already
  // spends colour on state — gold for a turn waiting on the person, green for
  // one that finished, the selection edge — and a second coloured thing on the
  // same row would make the person read which of the two a colour meant. It is
  // also why the palette is SIX hues and not eight: gold and green are spoken
  // for (utils/projectColor.ts).
  //
  // TWO CARRIERS in this rail, and only two: the flat stream's project line and
  // the folder header in the tree. Not the Starred or Remote band rows —
  // reviewed and cut on 2026-09-09. Those rows already carry the gold star or
  // the machine glyph, and a hue there would be a third colour channel on a row
  // that can also be wearing the needs-input wash; a red folder inside a gold
  // row is the exact fight the identity-colour clause exists to prevent. A
  // remote row filed under a local folder reads its project off that header,
  // which is what decision 3 asks for anyway.
  //
  // KEYED BY REPOSITORY, not by folder. A project is a repository, so this
  // disk's clone and a paired machine's copy of it are one project and wear one
  // hue — the machine is a glyph on the row, never a second colour, which keeps
  // the one-project-across-machines ruling intact. `folderIdentities` is
  // already read for every open folder, so the key costs nothing new; a folder
  // with no remote falls back to its normalised path.
  const projectColors = useProjectColors()

  // The key a folder group's header and rows colour by, or null when the group
  // is not a project at all: the "No folder" bucket, and a legacy remote group
  // whose root lives on another machine and has no local identity to read.
  //
  // `settled` is whether the repository question has been ANSWERED for this
  // folder. A hue is handed out only then: a project coloured under its path
  // key and re-keyed to its repository a moment later would spend two of the
  // six hues on one project and change colour just after the window opened,
  // which is the one thing decision 4 forbids. Until the answer lands the glyph
  // is simply the plain folder outline — one beat, once per project.
  const projectKeyOfGroup = useCallback(
    (group: FolderGroup): { key: string | null; settled: boolean } => {
      if (group.remote || !group.fullPath) return { key: null, settled: true }
      const identityKey = folderIdentityKey(group.fullPath)
      return {
        key: projectColorKey({
          folderPath: group.fullPath,
          repository: folderIdentities.get(identityKey) ?? null,
        }),
        settled: folderIdentities.has(identityKey),
      }
    },
    [folderIdentities]
  )
  const projectKeyByGroupKey = useMemo(() => {
    const map = new Map<string, { key: string | null; settled: boolean }>()
    for (const group of groups) map.set(group.key, projectKeyOfGroup(group))
    return map
  }, [groups, projectKeyOfGroup])
  const projectKeyOf = useCallback(
    (groupKey: string): string | null => projectKeyByGroupKey.get(groupKey)?.key ?? null,
    [projectKeyByGroupKey]
  )
  const projectKeySettled = useCallback(
    (groupKey: string): boolean => projectKeyByGroupKey.get(groupKey)?.settled === true,
    [projectKeyByGroupKey]
  )

  // A stream row's project line. The same header the tree would have filed the
  // row under, so switching views never renames anything: one resolver, two
  // shapes. It carries the colour too, since the line IS the glyph's only
  // caller in the flat stream.
  const flatProjectOf = useCallback(
    (workspace: Workspace) => {
      const groupKey = keyOf(workspace)
      const group = groupByKey.get(groupKey)
      const folderPath = group?.fullPath ?? workspace.folderPath ?? null
      return {
        name: group?.displayName ?? 'No folder',
        folderPath,
        color: resolveProjectColor(projectColors, projectKeyOf(groupKey)),
        // No folder is not a project (decision 6): the dashed grey outline, so
        // "unfiled" reads as its own thing rather than as a seventh project.
        // Narrower than "has no colour" on purpose — a project whose read has
        // not landed, whose person chose "No colour", or that lives on another
        // machine has a folder and is NOT unfiled; it keeps the solid glyph in
        // the row's own ink.
        unfiled: !group?.remote && !folderPath,
      }
    },
    [groupByKey, keyOf, projectKeyOf, projectColors]
  )

  // The row you are in always has a row: a settled chat you selected (or
  // settled from its own menu) keeps its place in the active list until you
  // leave it, and drops into the shelf then. Reading it never wakes it.
  const isShelved = useCallback(
    (workspace: Workspace) => isSettledWorkspace(workspace) && workspace.id !== activeWorkspaceId,
    [activeWorkspaceId]
  )

  // A project whose every chat has come to rest leaves the sidebar (owner
  // ruling, 2026-09-07). Its header was a line that said nothing was happening
  // — a folder name over a "Settled 1" fold and nothing to do — and a person
  // with a dozen quiet projects read a dozen of them before reaching the work.
  // It is not archived and not forgotten: the folder is still open, and New
  // chat is where you pick a project to start a conversation in. The tree shows
  // the projects that have something going on.
  //
  // A folder returns the moment anything in it wakes, is un-settled, or is
  // selected — the active chat is never shelved, so opening one of its chats
  // from search or New chat brings its project back with it.
  const activeGroups = useMemo(
    () => groups.filter((group) => !group.workspaces.every(isShelved)),
    [groups, isShelved]
  )

  // The Remote band's reads and rows (remote-sessions-in-the-sidebar): each
  // paired machine's sessions, read only while the band is open and this rail
  // is the one showing; a machine that is asleep is drawn from its last read.
  const remoteSessions = useRemoteSessions({ enabled: !remoteCollapsed && !contextRailActive })
  const { presence: remotePresence, browses: remoteBrowses, listening: remoteListening } = remoteSessions
  const remoteGroups = useMemo(
    () =>
      buildRemoteBand({
        connections: remotePresence.fleet,
        browses: remoteBrowses,
        attachments: remotePresence.fleetAttachments,
        reachability: remotePresence.fleetReachability,
        workspaces: railWorkspaces,
      }),
    [remotePresence.fleet, remoteBrowses, remotePresence.fleetAttachments, remotePresence.fleetReachability, railWorkspaces]
  )
  // One flat list, no machine headings (owner ruling 2026-09-05): the glyph
  // on each row says where it lives. Empty — and so the band absent — until
  // there is a conversation to open, or a window here that was born over there.
  const remoteItems = useMemo(
    () => remoteBandItems(remoteGroups, remoteListening, railWorkspaces),
    [remoteGroups, remoteListening, railWorkspaces]
  )

  // Every project this rail is about to DRAW, given a hue the first time it is
  // seen and never again (decision 4). Called ONCE here rather than per row:
  // the allocator hands out the first hue nobody is using, so it has to see the
  // whole list at once or two projects that arrived in the same paint would
  // both be given blue. The action writes nothing when no key is missing, which
  // is what makes this safe on every render.
  //
  // Folder groups and nothing else. The Remote band's rows carry no folder
  // glyph — the machine glyph is their mark — so a repository open only on a
  // paired machine has nothing here to wear a hue, and allocating one would
  // spend a sixth of the palette on a colour that is never drawn. A remote row
  // for a repository that IS an open folder here inherits that folder's key
  // through the group, which is the decision-3 behaviour and needs no key of
  // its own.
  const projectColorKeys = useMemo(() => {
    const keys: Array<string | null> = []
    for (const group of groups) {
      const project = projectKeyByGroupKey.get(group.key)
      if (project?.settled) keys.push(project.key)
    }
    return keys
  }, [groups, projectKeyByGroupKey])
  useAssignProjectColors(projectColorKeys)

  // Starred workspaces order the same way the folders do: by the person's last
  // message, newest first, and nothing else. This supersedes manual drag
  // position within the Starred section.
  // A starred row never settles on its own, but a person can settle one by
  // hand; rest means rest, so it then shows in its folder's shelf alone.
  const starredWorkspaces = useMemo(
    () =>
      sortWorkspacesByUserMessage(
        railWorkspaces.filter((workspace) => isStarred(workspace.highlight) && !isSettledWorkspace(workspace))
      ),
    [railWorkspaces]
  )

  const workspaceById = useMemo(() => {
    const map = new Map<WorkspaceId, Workspace>()
    for (const ws of workspaces) map.set(ws.id, ws)
    return map
  }, [workspaces])

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
    expandedSettledFolders,
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

    const folderWorkspaces = workspaces.filter((w) => keyOf(w) === fKey)
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
    const newOrder = reorderFolders(workspaces, drag.folderKey, fKey, position, keyOf)
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

  // Extract a dragged tab into a brand-new workspace. `folderPath` decides which
  // project the new workspace belongs to: the source workspace's folder when the
  // tab is dropped on the "New chat" target, or the folder's own path when it is
  // dropped straight onto a project header.
  const extractTabIntoNewWorkspace = useCallback(
    (payload: TabDragPayload, folderPath: string | null) => {
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

      const syntheticTemplate: LayoutTemplate = {
        id: `extracted-tab-${Date.now()}`,
        name: payload.name || 'Workspace',
        description: '',
        previewSlots: [],
        layout: buildSingleTabLayoutModel(spec),
      }

      const newWorkspaceId = addWorkspaceFromStore(syntheticTemplate, {
        name: payload.name || undefined,
        folderPath,
        windowId: workspaceWindowId,
      })

      migrateTabSideEffects(payload, newWorkspaceId)
      removeTab(payload.sourceWorkspaceId, payload.tabId, { preserveRuntime: true })
    },
    [addWorkspaceFromStore, migrateTabSideEffects, workspaceWindowId]
  )

  const handleTabDropOnNew = useCallback(
    (event: React.DragEvent) => {
      const payload = readTabDragPayload(event.dataTransfer)
      setTabDropTarget(null)
      if (!payload) return
      event.preventDefault()
      event.stopPropagation()

      const sourceWorkspace = workspaceById.get(payload.sourceWorkspaceId) ?? null
      extractTabIntoNewWorkspace(payload, sourceWorkspace?.folderPath ?? null)
    },
    [extractTabIntoNewWorkspace, workspaceById]
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

  // Dropping a tab on a project header extracts it into a NEW workspace filed
  // under that project — the gesture that reads as obvious once a project row is
  // on screen, and previously the one sidebar target that ignored tab drags
  // entirely (its handlers bail unless a folder-reorder drag is in flight). A
  // missing folder is refused: it cannot host a new workspace, matching the
  // folder context menu, which hides "New workspace" for the same reason.
  const handleTabDragOverFolder = useCallback(
    (event: React.DragEvent, group: FolderGroup) => {
      if (!dataTransferHasTabDrag(event.dataTransfer)) return
      if (group.missing) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setTabDropTarget({ kind: 'folder', key: group.key })
    },
    []
  )

  const handleTabDragLeaveFolder = useCallback((groupKey: string) => {
    setTabDropTarget((current) =>
      current?.kind === 'folder' && current.key === groupKey ? null : current
    )
  }, [])

  const handleTabDropOnFolder = useCallback(
    (event: React.DragEvent, group: FolderGroup) => {
      const payload = readTabDragPayload(event.dataTransfer)
      setTabDropTarget(null)
      if (!payload) return
      // A remote group has no local folder to file a tab under; accepting the
      // drop would create a folderless local workspace under a header that
      // names another machine.
      if (group.missing || group.remote) return
      event.preventDefault()
      event.stopPropagation()
      extractTabIntoNewWorkspace(payload, group.fullPath)
    },
    [extractTabIntoNewWorkspace]
  )

  const renderWorkspaceRow = (
    workspace: Workspace,
    fKey: string,
    options?: {
      keyPrefix?: string
      /** The band's rows lead with the machine glyph; its tooltip is where the machine is named. */
      remoteMachine?: string
      /** A row in its folder's Settled shelf: title and the hover actions, nothing that asks for a look. */
      settled?: boolean
      /**
       * The row is in the flat stream (all-chats-view), where there is no
       * folder header above it: it grows a line for the project it belongs to,
       * and that line takes the row's clock and its hover actions. Null in the
       * tree, where the header says the project once for all its chats.
       */
      flatProject?: { name: string; folderPath: string | null; color: ProjectColor | null; unfiled: boolean }
    }
  ) => {
    // When a door-routed full-page surface owns the card region (epic 1704), no
    // workspace row is "current" — the door row carries the selection, so a
    // highlighted project row here would be a second, conflicting selected state.
    const active = !globalSurfaceActive && workspace.id === activeWorkspaceId
    const flatProject = options?.flatProject ?? null
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
    // The row that wants you: it wears the gold treatment instead of a dot.
    const needsAttention = activity === 'needs-input'
    // The row that finished while you were away: the same treatment in green,
    // held until you open it. Gold outranks it when both apply.
    const unseenDone = !needsAttention && unseenDoneIds.has(workspace.id)
    const folderMissing = workspace.folderMissing === true
    const starred = isStarred(workspace.highlight)
    // "Hot": at least one resident (live-PTY) agent — instant to switch into.
    // Said in words for a screen reader; it no longer claims a visual channel.
    // Weight now belongs to the row that is MOVING (see `emphasis` below), and
    // residency is not movement: a chat whose CLI process happens to still be
    // up, untouched since this morning, is background whatever its pty is
    // doing (owner, 2026-09-07).
    const resident = residentWorkspaceIds.has(workspace.id)
    // How loudly this row is drawn — weight for the row you are in and the
    // rows that are working, muted ink for everything that has gone quiet.
    // Reads the same clock the row's own idle label shows, falling back to the
    // record when there is no terminal recency to read (a parked chat).
    const emphasis = workspaceRowEmphasis({
      selected: active,
      working: activity === 'working',
      wantsYou: needsAttention || unseenDone,
      settled: options?.settled === true,
      lastActiveAt: recency?.idleSince ?? workspaceLastActiveAt(workspace),
      now,
    })
    const highlighted = hasHighlightOverride(workspace.highlight)
    const dropMark =
      dropIndicator?.kind === 'workspace' && dropIndicator.targetId === workspace.id
        ? dropIndicator.position
        : null
    const isTabDropTarget =
      tabDropTarget?.kind === 'workspace' && tabDropTarget.id === workspace.id
    const rowKey = `${options?.keyPrefix ?? ''}${workspace.id}`
    // The row's lines (sidebar-lists-every-terminal): one per open terminal —
    // the local live sessions AND the fleet panes the layout mounts from
    // other machines.
    // Owner ruling 2026-09-04 (the-diff-an-agent-made, decision 9): a row with
    // no open terminal is the one-liner it always was — title only, with idle
    // recency keeping its old seat in the line-1 status cluster. Its branch and
    // ±lines are not facts about a chat that is not running; they are the
    // checkout's current state, which a parked chat has no claim on. So the
    // lines, and everything on them, are gated on liveness: no terminal, no
    // line. (The poll above already asks about live rows only; the gate here
    // keeps the render honest even mid-transition.)
    const rowIsLive = rowHasOpenTerminals(workspace, sessionsByWorkspaceId)
    // A settled row is the one-liner by construction: rest is the point, and
    // a checkout's branch and ±lines are not facts about a chat at rest.
    const rowLines = rowIsLive && !options?.settled
      ? terminalLinesOf({
          workspace,
          sessions: sessionsByWorkspaceId.get(workspace.id) ?? [],
          fleetPanes: fleetPanesOf(workspace),
          summaries: gitSummaries,
        })
      : { lines: [], overflow: 0, rowDiff: null }
    // A band row names its machine on the title glyph, so its lines do not
    // say it again; a local row that holds a remote pane still marks it there.
    if (options?.remoteMachine) for (const line of rowLines.lines) line.machineName = null
    // The one thing a parked row still gets to say (orchestrator ruling
    // 2026-09-07). The gate above is about the checkout's live state, which a
    // chat with nothing running has no claim on; a worktree workspace's branch
    // is not that. The workspace IS the worktree, cut onto a branch the app
    // minted for it, and it stays that whether or not a terminal is up — the
    // same durable fact its header no longer says now that the row files under
    // the project it came from. So: the branch chip, alone, and no ± diff,
    // which would be live state again.
    const parkedWorktreeBranch = rowIsLive ? null : workspace.worktree?.branch?.trim() || null
    const metaHasSubstance = rowLines.lines.length > 0 || parkedWorktreeBranch !== null

    // The row's status seat: run glyph / working dots + elapsed / tone dot /
    // idle recency, with the hover-revealed row actions layered over it.
    //
    // Owner ruling 2026-09-04: this used to live on line 1, where its
    // permanently reserved 44px plus its gap cost every title a fifth of the
    // sidebar's content column. It now rides line 2's trailing edge whenever
    // there IS a line 2, so the title claims the full width the way list-row
    // says it should; a row with no meta to show keeps the seat exactly where
    // it was, and stays exactly the height it was.
    const rowActionsOverlay = (
      <>
        {/* Hover-and-focus-revealed row actions: keyboard focus surfaces them
            (group-focus-within) so they are reachable and never a focus trap
            on an invisible control. The seat's min-w is the width they reserve
            (list-row's `data-actions` rule), so revealing never reflows — and
            reserving it here rather than on line 1 is the whole point of the
            move. */}
        <span className="pointer-events-none absolute inset-y-0 right-0 inline-flex items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <Tooltip content="More actions">
            <IconButton
              onClick={(event) => {
                event.stopPropagation()
                setContextMenu({
                  workspaceId: workspace.id,
                  x: (event.currentTarget as HTMLElement).getBoundingClientRect().right,
                  y: (event.currentTarget as HTMLElement).getBoundingClientRect().bottom,
                })
              }}
              tone="quiet"
              aria-label="Workspace actions"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="icon-xs" aria-hidden="true">
                <circle cx="3.5" cy="8" r="1.2" />
                <circle cx="8" cy="8" r="1.2" />
                <circle cx="12.5" cy="8" r="1.2" />
              </svg>
            </IconButton>
          </Tooltip>
          {/* The one-click seat is rest, not removal (settled-chats,
              2026-09-07). It used to be the ✕, which terminates the row's
              terminals and removes the chat — the irreversible gesture in the
              cheapest place on the row, and against this epic's own thesis
              that a chat comes to rest instead of vanishing. Close keeps its
              entry in `···`, where a gesture that cannot be taken back
              belongs; Settle, the one you make fifty times a day and can undo
              with the next click, takes the seat.

              Neutral ink, deliberately: green already means "an agent
              finished while you were away — come look" on this exact surface
              (`doneRowClass` washes the whole row in --tone-good-faint), so a
              green tick would be the opposite instruction in the same hue six
              pixels away — the mistake the green ring was struck down for
              (owner ruling 2026-09-05). The tick's SHAPE says done; it does
              not need the tone to say it.

              A settled row gets the undo arrow rather than a second tick: the
              action there is "put this back", and a tick would still be
              saying "done" about the state you are leaving.

              A row born on a paired machine keeps the ✕: the Remote band has
              no Settled shelf, so it has nothing to settle into — the same
              rule the menu's Settle entry follows. */}
          {workspace.remoteOrigin ? (
            <Tooltip content="Close workspace">
              <IconButton
                  onClick={(event) => {
                  event.stopPropagation()
                  handleClose(workspace.id)
                }}
                tone="quiet"
                aria-label={`Close ${workspace.name}`}
              >
                <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                  <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </IconButton>
            </Tooltip>
          ) : options?.settled ? (
            <Tooltip content="Un-settle">
              <IconButton
                  onClick={(event) => {
                  event.stopPropagation()
                  setWorkspaceSettled(workspace.id, false)
                }}
                tone="quiet"
                aria-label={`Un-settle ${workspace.name}`}
              >
                <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                  <path
                    d="M6.2 3.3L3 6l3.2 2.7"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M3 6h6.4a3.3 3.3 0 0 1 0 6.6H7.2"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </IconButton>
            </Tooltip>
          ) : (
            <Tooltip content="Settle">
              <IconButton
                  onClick={(event) => {
                  event.stopPropagation()
                  settleWorkspaceById(workspace.id)
                }}
                tone="quiet"
                aria-label={`Settle ${workspace.name}`}
              >
                {/* `CheckIcon`'s geometry (24-grid, M5 12.5L10 17L19 7.5)
                    brought onto the 16-grid at its 1.4 stroke and inset to the
                    12×12 live area. */}
                <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                  <path
                    d="M3.75 8.5L6.5 11.25L12.25 5.25"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </IconButton>
            </Tooltip>
          )}
        </span>
      </>
    )
    const statusSeat = options?.settled ? (
      // A settled row keeps the seat for its hover actions and nothing else:
      // no dot, no glyph, no idle clock — the shelf already says it is resting.
      <span className="relative ml-auto flex h-5 min-w-[44px] shrink-0 items-center justify-end pl-2">
        {rowActionsOverlay}
      </span>
    ) : (
      <span className="relative ml-auto flex h-5 min-w-[44px] shrink-0 items-center justify-end pl-2">
        <span className="inline-flex items-center gap-1 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
          {runGlyph && runGlyphLabel ? (
            <Tooltip content={runGlyphLabel}>
              <LifecycleGlyph state={runGlyph.state} live={runGlyph.live} label={runGlyphLabel} />
            </Tooltip>
          ) : null}
          {/* Active work earns the three-dot working marker; the other
              attention states keep the tone dot. */}
          {/* An attention row renders NO dot: the row's own gold surface is the
              mark, and status-dot's spec calls a dot beside something already
              saying the same thing a reject-on-sight. Working and failed keep
              their marks — neither tints the row. */}
          {!runGlyph && tone && !needsAttention ? (
            activity === 'working' ? (
              <>
                <AgentWorkingDots label={activityLabel(activity)} />
                {/* How long the turn has been running. The workspace-level
                    activity above decides WHETHER work is in flight (hooks are
                    the authority on that); the terminal snapshot only supplies
                    the timestamp, and a turn without one simply shows the dots
                    alone. */}
                {typeof recency?.workingSince === 'number' ? (
                  <WorkingElapsed since={recency.workingSince} />
                ) : null}
              </>
            ) : (
              <StatusDot tone={tone.tone} pulse={tone.pulse} label={activityLabel(activity)} />
            )
          ) : null}
          {showRecencyText ? (
            <Tooltip content={`Idle ${formatRelativeMsAgo(recency!.idleSince!, now)} (${new Date(recency!.idleSince!).toLocaleString()})`}>
              <span
                className={`text-meta tabular-nums ${
                  emphasis === 'quiet' ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-subtle)]'
                }`}
              >
                <span aria-hidden="true">{idleRecencyText}</span>
                <span className="sr-only">Idle {formatRelativeMsAgo(recency!.idleSince!, now)}</span>
              </span>
            </Tooltip>
          ) : null}
        </span>
        {rowActionsOverlay}
      </span>
    )

    // The row's conversation peek (2026-09-07). The row says what the chat is
    // CALLED; the card says what was actually asked — the message that started
    // it, everything sent since, and the model and session behind it. Null when
    // there is no session id worth asking about: nothing to read, and a card
    // that only restated the row's own title is the noise this replaced.
    //
    // Note the map: every session main knows about, running or not, and then
    // the row's own agent records. Whether the PROCESS is alive is not the
    // question — whether there is an id to ask about is.
    // One identity per agent (2026-09-09): the card opens from the agent line
    // the pointer is on, and a chat with a single agent opens from its row.
    const peekIdentities = rowConversationPeekIdentities({
      workspace,
      sessions: peekSessionsByWorkspaceId.get(workspace.id) ?? [],
      status: peekStatusOf(activity, idleRecencyText),
      now,
    })
    const hasPeek = peekIdentities.length > 0
    // The whole row is the peek's hover target (owner ruling 2026-09-07), which
    // costs the title its own tooltip. `TruncatedText` opens one the moment a
    // title is clipped, and with the card opening from the same row that would
    // be a second surface over the first — saying the same name the card's
    // header is already saying in full. So where there IS a peek the title
    // truncates plainly and the card carries the name.
    //
    // Only where there is one. A row with no agent session opens no card, and
    // dropping the tooltip there too would leave a long chat name with no way
    // to be read at all — so that row keeps `TruncatedText` exactly as it was.
    // `TruncatedText` itself is untouched; this is only how the row uses it.
    const titleClusterClass = `flex min-w-0 flex-1 items-center gap-1.5 ${folderMissing ? 'line-through decoration-[color:var(--text-subtle)]' : ''}`
    const titleClass = `min-w-0 flex-1 ${
      // Weight ONLY, and for every row anyone is using — the row you are in,
      // the ones working, the ones that want you, and anything touched inside
      // the hour. The ink lift stays selection's channel, not weight's: the
      // selected row is the one that also brightens (its row class carries
      // `--text-strong`), so a bold row never reads as the row you are in
      // (design-system/patterns/selection.html). It is also what keeps the
      // mark honest on an attention row, where a second ink would cancel the
      // warn colour the row is wearing.
      emphasis === 'active' ? 'font-semibold' : ''
    } ${
      // The background tier, and deliberately a step below list-row's Rest:
      // `text.muted` still read as foreground on this near-black rail, so a
      // chat nobody is using sits at `text.subtle` and lifts to `text.default`
      // on hover — reaching for one is never reading dim text. Selection's own
      // ink lift never reaches here: a selected row is `active`.
      emphasis === 'quiet'
        ? 'text-[color:var(--text-subtle)] group-hover:text-[color:var(--text-default)]'
        : ''
    }`
    const titleClusterContent = (
      <>
        {options?.remoteMachine ? <RemoteRowGlyph machineName={options.remoteMachine} /> : null}
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
        {hasPeek ? (
          <span className={`${titleClass} truncate`}>{workspace.name}</span>
        ) : (
          <TruncatedText as="span" text={workspace.name} className={titleClass} />
        )}
        {resident ? <span className="sr-only"> (agents resident)</span> : null}
        {/* The gold surface is the visible mark; this is the same meaning
            in words, since no state may be carried by colour alone. */}
        {needsAttention ? <span className="sr-only"> (needs your input)</span> : null}
        {unseenDone ? <span className="sr-only"> (finished while you were away)</span> : null}
        {options?.settled ? <span className="sr-only"> (settled)</span> : null}
      </>
    )
    const titleCluster = hasPeek ? (
      <ConversationPeekPopover
        identities={peekIdentities}
        now={now}
        className={titleClusterClass}
        onOpenDiff={(path, agentId) =>
          openPaneTab(workspace.id, {
            kind: 'diff',
            diff: {
              focusPath: path,
              focusKind: path ? 'unstaged' : null,
              // The card is one agent's conversation, so "open the diff" is
              // that agent's changelist — named outright rather than left to
              // the workspace's last-active default, which answers a different
              // question and could answer it with a different agent.
              ...(agentId ? { changelistId: changelistOwnerId(agentId) } : {}),
            },
          })
        }
      >
        {titleClusterContent}
      </ConversationPeekPopover>
    ) : (
      <span className={titleClusterClass}>{titleClusterContent}</span>
    )

    return (
      <div
        key={rowKey}
        data-row-key={rowKey}
        // Roving tabindex: exactly one treeitem is in the tab order at a time,
        // and Arrow/Home/End move focus between rows (handleTreeRowKeyDown).
        tabIndex={rovingKey === rowKey ? 0 : -1}
        onFocus={() => setRovingKey(rowKey)}
        onKeyDown={(event) => handleTreeRowKeyDown(event, workspace.id)}
        // Drag-to-reorder is the tree's: it rewrites the stored order of a
        // folder's chats, and the flat stream is ordered by the clock, so a
        // drag there would move a row you cannot see moving. Dropping a
        // TERMINAL onto a chat is untouched — that is not about order.
        draggable={!renamingId && !flatProject}
        onDragStart={(event) => {
          if (flatProject) return
          handleRowDragStart(event, workspace, fKey)
        }}
        onDragOver={(event) => {
          if (dataTransferHasTabDrag(event.dataTransfer)) {
            handleTabDragOverRow(event, workspace)
            return
          }
          if (flatProject) return
          handleRowDragOver(event, workspace, fKey)
        }}
        onDragLeave={() => handleTabDragLeaveRow(workspace.id)}
        onDrop={(event) => {
          if (dataTransferHasTabDrag(event.dataTransfer)) {
            handleTabDropOnRow(event, workspace)
            return
          }
          if (flatProject) return
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
        // design-tokens-allow: alignment — 26px inset after the 4px highlight rail puts the row title on the sidebar's 36px content column (see the layout note below); the flat stream has no folder header to sit under, so its rows give the indent back and start on the column's own 16px edge, where New chat starts
        // Two-line row (remote-sessions-ux): a column now — line 1 is the title
        // + status cluster, line 2 the meta (heads · provenance · branch ·
        // diff). min-h keeps a metaless row exactly the height it always was.
        className={`interactive group relative mx-1.5 my-0.5 flex min-h-control-sm cursor-pointer select-none flex-col justify-center gap-0.5 rounded-md border-l-[4px] border-l-transparent py-1 pr-1.5 text-heading ${
          flatProject ? 'pl-1.5' : 'pl-[26px]'
        } ${FOCUS_RING_CLASS} ${
          needsAttention
            ? attentionRowClass(active)
            : unseenDone
              ? doneRowClass(active)
              : active
                ? activeRowClass(workspace)
                : highlighted
                  ? `${inactiveHighlightClass(workspace)} text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]`
                  : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]'
        } ${folderMissing ? 'opacity-70' : ''}`}
        role="treeitem"
        aria-current={active ? 'true' : undefined}
      >
        {/* The flat stream's top line (all-chats-view): the project this chat
            belongs to, and the clock — or what the agent is doing — at the
            trailing edge. It is the one line that is the same shape on every
            row, which is what lets the eye find the clock without reading the
            row; in the tree the folder header says the project instead and the
            clock rides whichever line the row happens to end on.

            A folder glyph, not the project's logo: the logo belongs to the one
            header that names the project (MC-2135, reversed 2026-09-02 for
            exactly this — a project's mark once per chat is repetition), and
            this line is a row's filing, not a heading. */}
        {flatProject ? (
          <div
            className={`flex h-5 min-w-0 items-center gap-1.5 text-meta ${
              emphasis === 'quiet' ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-subtle)]'
            }`}
          >
            {/* THE glyph the project's colour lives on in the flat stream
                (one-colour-per-project, 2026-09-09). The name beside it stays
                in the row's own ink: the hue identifies the project, and a
                coloured word would be a second, louder saying of it. */}
            <FolderTypeIcon
              className="icon-xs shrink-0"
              color={flatProject.color}
              unfiled={flatProject.unfiled}
            />
            <span className="min-w-0 truncate">{flatProject.name}</span>
            {statusSeat}
          </div>
        ) : null}
        <AttentionPulse active={needsAttention} resetKey={workspace.id} />
        <AttentionPulse active={unseenDone} resetKey={workspace.id} tone="good" />
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

        <div className="flex min-w-0 items-center gap-2">
        {/* No identity slot on the row. Owner, 2026-09-02: the project's
            discovered logo belongs to the FOLDER header that names the project,
            not repeated once per chat beneath it, and the terminal glyph the
            logo-less rows fell back to said nothing a row of chats needs said.
            So the row opens on its title again, as it did before MC-2135's
            ruling C, and the whole slot — logo and glyph — moved up to the
            header (`FolderIdentityIcon`). Mode identity still reads from the
            row accent, the trailing run glyph, and the inline sprint mark. */}
        {renamingId === workspace.id ? (
          // The kit's field, spliced into a row that has already decided its
          // height: `size="none"` spends no ramp step, so the inset and the
          // row's own type step stay here as layout. `variant="default"` is
          // the right ground — `--bg-field` IS `--bg-surface-raised` on an
          // opaque window — and brings the border, the radius, the hover edge
          // lift and the one focus ring with it.
          <Input
            ref={renameInputRef}
            size="none"
            fullWidth={false}
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={commitRename}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') setRenamingId(null)
              event.stopPropagation()
            }}
            className="min-w-0 flex-1 px-1.5 py-0 text-heading"
          />
        ) : (
          titleCluster
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

        {/* A sprint run's lifecycle is the ROW's state, not a terminal's, so
            when the LINES carry the seats it keeps line 1's trailing edge —
            a terminal's seat has no room for it. The parked worktree line
            below carries the row's own `statusSeat`, which already draws this
            glyph, so the condition is the lines and not `metaHasSubstance`:
            the two diverged the moment a lineless row could have a line 2,
            and asking the wrong one drew the glyph twice on any row whose
            module hands it one. */}
        {rowLines.lines.length > 0 && runGlyph && runGlyphLabel ? (
          <Tooltip content={runGlyphLabel}>
            <LifecycleGlyph state={runGlyph.state} live={runGlyph.live} label={runGlyphLabel} />
          </Tooltip>
        ) : null}
        {/* A lineless row has no line to carry the seat, so it keeps it
            here — the one-liner it always was. Never in the flat stream,
            where the project line above already took it. */}
        {metaHasSubstance || flatProject ? null : statusSeat}
        </div>
        {parkedWorktreeBranch ? (
          // The same line container a terminal's line uses, so a parked
          // worktree row is exactly as tall as a live one and its seat sits
          // where every other seat sits.
          <div
            className={`flex h-5 min-w-0 items-center gap-2 overflow-hidden text-meta ${
              emphasis === 'quiet' ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-subtle)]'
            }`}
          >
            <BranchChip
              branch={parkedWorktreeBranch}
              worktree
              cwd={workspace.folderPath ?? null}
              dim={emphasis === 'quiet'}
            />
            {flatProject ? null : statusSeat}
          </div>
        ) : null}
        {rowLines.lines.map((line, index) => {
          // An agent line's ±count is that agent's own work, so pressing it
          // opens that agent's changelist. The agent id comes from the row's
          // sessions rather than from the line, because a line is a drawing of
          // a terminal and the diff is a fact about the agent inside it.
          const lineAgentId =
            line.kind === 'agent'
              ? (peekSessionsByWorkspaceId.get(workspace.id) ?? []).find(
                  (session) => session.sessionId === line.key,
                )?.agentId ?? null
              : null
          return (
            <TerminalLineView
              key={line.key}
              line={line}
              now={now}
              seatOverlay={index === 0 && !flatProject ? rowActionsOverlay : undefined}
              disambiguate={rowLines.lines.length > 1}
              dim={emphasis === 'quiet'}
              rowOwnsStatus={flatProject !== null}
              onOpenDiff={
                lineAgentId
                  ? () =>
                      openPaneTab(workspace.id, {
                        kind: 'diff',
                        diff: {
                          focusPath: null,
                          focusKind: null,
                          changelistId: changelistOwnerId(lineAgentId),
                        },
                      })
                  : undefined
              }
            />
          )
        })}
        {rowLines.overflow > 0 ? (
          <div
            className={`flex h-5 items-center text-micro ${
              emphasis === 'quiet' ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-subtle)]'
            }`}
          >
            +{rowLines.overflow} more {rowLines.overflow === 1 ? 'terminal' : 'terminals'}
          </div>
        ) : null}
      </div>
    )
  }

  // A conversation on a paired machine that no workspace here is attached to
  // (remote-sessions-in-the-sidebar): the same two-line shape as a workspace
  // row — the machine glyph and the title, then heads · branch · diff with the
  // status in the seat — and opening it attaches here. No drag, rename, or
  // close: those are a workspace's, and this row has none until it is opened.
  //
  // The seat and the surface are the local rows' own (owner ruling
  // 2026-09-05): the working dots with how long the turn has run, the gold
  // surface for a turn waiting on a person, a quiet time since an idle row
  // last worked. No status dot — that vocabulary was already spoken for.
  const renderRemoteSessionRow = (row: RemoteSessionRow, machineName: string) => {
    const rowKey = `remote-session-${row.key}`
    const open = () => onOpenRemoteSession?.(openSpecOf(row))
    const needsAttention = row.activity === 'needs-input'
    const surface = needsAttention
      ? attentionRowClass(false)
      : row.activity === 'paused'
        ? 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]'
        : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]'
    return (
      <div
        key={rowKey}
        data-row-key={rowKey}
        data-remote-session={row.sessionId}
        data-remote-activity={row.activity}
        tabIndex={rovingKey === rowKey ? 0 : -1}
        onFocus={() => setRovingKey(rowKey)}
        onKeyDown={(event) => handleTreeRowKeyDown(event, null, open)}
        onClick={open}
        // design-tokens-allow: alignment — the same 26px inset as the workspace rows, so a remote title sits on the content column
        className={`interactive group relative mx-1.5 my-0.5 flex min-h-control-sm cursor-pointer select-none flex-col justify-center gap-0.5 rounded-md border-l-[4px] border-l-transparent py-1 pl-[26px] pr-1.5 text-heading ${surface} ${FOCUS_RING_CLASS}`}
        role="treeitem"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <RemoteRowGlyph machineName={machineName} />
            {/* Weight marks a running turn, the way residency bolds a local row. */}
            <TruncatedText as="span" text={row.title} className={`min-w-0 flex-1 ${row.activity === 'working' ? 'font-semibold' : ''}`} />
            <span className="sr-only"> (on {machineName}, not open here)</span>
            {needsAttention ? <span className="sr-only"> (needs your input)</span> : null}
            {row.activity === 'paused' ? <span className="sr-only"> (paused)</span> : null}
          </span>
        </div>
        <TerminalLineView line={lineOfRemoteRow(row)} now={now} />
      </div>
    )
  }

  // Renders a folder's workspace rows: the active rows, most recently messaged
  // first, then — only when the folder has any — its Settled shelf
  // (settled-chats, 2026-09-07): one fold row carrying the count, closed by
  // default, over the resting rows in compact form, in that same order. The shelf
  // replaces the old "Show N older" recency fold: a chat now rests by the
  // settle rule (`utils/workspaceSettle.ts`), never by a fold that hid it.
  // `folderBodyId` lets the folder header's toggle button own an
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

    const activeRows = visibleWorkspaces.filter((workspace) => !isShelved(workspace))
    const settledRows = sortWorkspacesByUserMessage(visibleWorkspaces.filter(isShelved))

    if (settledRows.length === 0) {
      return (
        <div id={folderBodyId}>
          {activeRows.map((workspace) => renderWorkspaceRow(workspace, group.key))}
        </div>
      )
    }

    const expanded = expandedSettledFolders[group.key] === true
    const shelfId = `ws-settled-${group.key.replace(/[^a-z0-9]+/giu, '-')}`

    return (
      <div id={folderBodyId}>
        {activeRows.map((workspace) => renderWorkspaceRow(workspace, group.key))}
        <SettledShelfRow
          count={settledRows.length}
          expanded={expanded}
          controlsId={shelfId}
          onToggle={() =>
            setExpandedSettledFolders((prev) => ({ ...prev, [group.key]: !expanded }))
          }
        />
        <div
          id={shelfId}
          role="group"
          aria-label={`Settled chats in ${group.displayName}`}
          hidden={!expanded}
        >
          {expanded
            ? settledRows.map((workspace) => renderWorkspaceRow(workspace, group.key, { settled: true }))
            : null}
        </div>
      </div>
    )
  }

  // The flat stream (all-chats-view, 2026-09-07): every local chat in one list,
  // ordered by when you last messaged each (owner, 2026-09-07 — this list used
  // to count the agent's turn too, and a chat finishing then jumped ahead of
  // the row you were reaching for). No headings: the gold and green washes say
  // which rows want you, and a band would be a second, weaker way of saying it
  // (owner, 2026-09-07).
  //
  // Rest works exactly as it does in the tree, with one shelf instead of one
  // per project: the same rows, the same fold, the same count.
  //
  // Rows born on a paired machine stay the Remote band's alone, as they are in
  // the tree — the band is above this list either way.
  const renderChatStream = () => {
    const streamRows = sortWorkspacesByUserMessage(localRailWorkspaces.filter((w) => !isShelved(w)))
    const settledRows = sortWorkspacesByUserMessage(localRailWorkspaces.filter(isShelved))
    const expanded = expandedSettledFolders[ALL_CHATS_SHELF_KEY] === true
    return (
      <section className="relative pt-1" aria-label="All chats">
        {streamRows.map((workspace) =>
          renderWorkspaceRow(workspace, keyOf(workspace), {
            keyPrefix: 'all-',
            flatProject: flatProjectOf(workspace),
          })
        )}
        {settledRows.length > 0 ? (
          <>
            <SettledShelfRow
              count={settledRows.length}
              expanded={expanded}
              flush
              controlsId={ALL_CHATS_SHELF_ID}
              onToggle={() =>
                setExpandedSettledFolders((prev) => ({ ...prev, [ALL_CHATS_SHELF_KEY]: !expanded }))
              }
            />
            <div id={ALL_CHATS_SHELF_ID} role="group" aria-label="Settled chats" hidden={!expanded}>
              {expanded
                ? settledRows.map((workspace) =>
                    renderWorkspaceRow(workspace, keyOf(workspace), {
                      keyPrefix: 'all-',
                      settled: true,
                      flatProject: flatProjectOf(workspace),
                    })
                  )
                : null}
            </div>
          </>
        ) : null}
      </section>
    )
  }

  // One folder's section: the header (drag, context menu, disclosure) over the
  // body.
  const renderFolderSection = (group: FolderGroup) => {
    const collapsed = collapsedFolders[group.key] === true
    // Rows order by the person's last message, newest first. A finishing or
    // blocked agent tints the row but never moves it (owner ruling
    // 2026-09-09) — the same order the Starred band and the flat stream use,
    // so a row only ever changes seat when someone speaks in it.
    const visibleWorkspaces = sortWorkspacesByUserMessage(group.workspaces)
    const folderBodyId = `ws-folder-body-${group.key.replace(/[^a-z0-9]+/giu, '-')}`
    const dropMark =
      dropIndicator?.kind === 'folder' && dropIndicator.targetKey === group.key
        ? dropIndicator.position
        : null
    const isFolderTabDropTarget =
      tabDropTarget?.kind === 'folder' && tabDropTarget.key === group.key
    return (
      <section key={group.key} className="relative pt-1">
        {/* The header container carries drag + context-menu; the disclosure
            itself is a real button (aria-expanded / aria-controls) so the
            folder is keyboard-operable, with the overflow control as a
            sibling rather than a nested interactive element. */}
        <header
          draggable
          onDragStart={(event) => handleFolderDragStart(event, group.key)}
          onDragOver={(event) => {
            if (dataTransferHasTabDrag(event.dataTransfer)) {
              handleTabDragOverFolder(event, group)
              return
            }
            handleFolderDragOver(event, group.key)
          }}
          onDragLeave={() => handleTabDragLeaveFolder(group.key)}
          onDrop={(event) => {
            if (dataTransferHasTabDrag(event.dataTransfer)) {
              handleTabDropOnFolder(event, group)
              return
            }
            handleFolderDrop(event, group.key)
          }}
          onDragEnd={handleDragEnd}
          onContextMenu={(event) => {
            event.preventDefault()
            setFolderMenu({ folderKey: group.key, x: event.clientX, y: event.clientY })
          }}
          // `min-h-control-sm`, not a fixed 26px: the fold row inside is the
          // kit's nav row now, and its floor is the sidebar's control step.
          className={`group/folder relative flex min-h-control-sm select-none items-center gap-1.5 pr-2 text-[color:var(--text-muted)] ${
            group.missing ? 'text-[color:var(--tone-warn)]' : ''
          }`}
        >
          {dropMark === 'before' ? (
            <span aria-hidden="true" className="absolute inset-x-1 top-[-1px] h-[2px] rounded bg-[color:var(--accent-primary)]" />
          ) : null}
          {dropMark === 'after' ? (
            <span aria-hidden="true" className="absolute inset-x-1 bottom-[-1px] h-[2px] rounded bg-[color:var(--accent-primary)]" />
          ) : null}
          {isFolderTabDropTarget ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-1 inset-y-0 rounded-md ring-2 ring-[color:var(--accent-primary)]"
            />
          ) : null}
          <Tooltip
            content={
              group.remote
                ? `${group.remote.machineName} · ${group.remote.workspaceRoot ?? 'remote workspace'}`
                : group.fullPath ?? 'Workspaces with no folder'
            }
            placement="bottom"
            wrapperClassName="flex h-full min-w-0 flex-1"
          >
          {/* The kit's nav row. The missing-folder hover tint is gone rather
              than carried over: it was a second `hover:text-[color:var(--…)]`
              at equal specificity, so which ink painted was stylesheet order.
              The `Missing` chip beside the name is what states that fact. */}
          <RowButton
            density="nav"
            onClick={() =>
              setCollapsedFolders((prev) => ({ ...prev, [group.key]: !collapsed }))
            }
            aria-expanded={!collapsed}
            aria-controls={folderBodyId}
            className="min-w-0 flex-1 pl-4"
          >
            {/* One icon slot, Cursor-style: the folder's identity at
                rest — the project's own logo when its repo has one, the
                folder glyph when it does not (MC-2135, re-sited here by
                the owner on 2026-09-02) — and the collapse chevron
                swapped in on hover. */}
            <span className="relative flex size-icon-sm shrink-0 items-center justify-center">
              {/* A remote group's root lives on another machine: looking
                  it up on THIS disk would present an unrelated local
                  folder's logo (or stat a path that does not exist), so
                  the header wears the neutral mark until the gateway
                  serves project identity.

                  The project's colour rides the same slot, and the logo still
                  wins inside FolderIdentityIcon: a detected logo already
                  answers "which project is this", and a hue behind it would
                  answer it twice. The "No folder" bucket is not a project at
                  all, so it gets the dashed outline instead of a hue. */}
              <FolderIdentityIcon
                folderPath={group.remote ? null : group.fullPath}
                className="icon-sm shrink-0 transition-opacity group-hover/folder:opacity-0"
                color={resolveProjectColor(projectColors, projectKeyOf(group.key))}
                unfiled={!group.remote && !group.fullPath}
              />
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
            {group.remote ? (
              <RemoteMachineGlyph className="icon-xs shrink-0 text-[color:var(--text-muted)]" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-heading font-semibold text-[color:var(--text-strong)]">
              {group.displayName}
            </span>
          </RowButton>
          </Tooltip>
          {group.missing ? (
            <span className="inline-flex items-center gap-1.5 text-meta font-medium text-[color:var(--tone-warn)]">
              <StatusDot tone="warn" label="Folder missing" />
              Missing
            </span>
          ) : null}
          <Tooltip content="Folder actions">
            <IconButton
              onClick={(event) => {
                event.stopPropagation()
                setFolderMenu({
                  folderKey: group.key,
                  x: (event.currentTarget as HTMLElement).getBoundingClientRect().right,
                  y: (event.currentTarget as HTMLElement).getBoundingClientRect().bottom,
                })
              }}
              tone="quiet"
              className="ml-1 opacity-0 transition-opacity group-hover/folder:opacity-100 focus-visible:opacity-100"
              aria-label={`Folder actions: ${group.displayName}`}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="icon-xs" aria-hidden="true">
                <circle cx="3.5" cy="8" r="1.2" />
                <circle cx="8" cy="8" r="1.2" />
                <circle cx="12.5" cy="8" r="1.2" />
              </svg>
            </IconButton>
          </Tooltip>
        </header>
        {renderFolderBody(group, visibleWorkspaces, collapsed, folderBodyId)}
      </section>
    )
  }

  return (
    <aside
      ref={sidebarRef}
      aria-label="Workspaces"
      // The shell's LEADING list, so `primary` rather than `auto`
      // (assets/index.css, "Selection tiers"). `auto` rests on anything that is
      // not `:focus-within`, and the pane beside this one is a terminal or a
      // chat transcript — a canvas, not a selection pane. So in the app's
      // ordinary state, focus sits outside every marked pane and the current
      // chat's row spent its whole life at the resting tier: the fill dropped a
      // rung and `--text-strong` fell back to `--text-default`, which left the
      // selected row DIMMER than a neighbouring resident row wearing
      // `font-semibold text-strong` on its own. The screen showed zero focused
      // selections — the failure the pattern exists to prevent. `primary`
      // holds the tier while focus sits outside every pane and rests only once
      // another pane (the composer's roster, the file tree) actually takes it,
      // which is the same ruling the door rails already carry.
      //
      // Dropped entirely while a door owns this column, because then this aside
      // is not the pane — the door's rail inside it is, and that rail declares
      // itself `primary`. Two `primary` marks nested one inside the other would
      // put two full-strength selections on one screen the moment focus left
      // both, and "one per surface" is the whole rule. Nothing here loses its
      // own tier by standing down: the workspaces tree is `hidden` in that
      // state, so its rows are neither visible nor focusable.
      {...(contextRailActive ? {} : { 'data-selection-pane': 'primary' })}
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
        className={`group absolute right-0 top-0 z-[var(--z-pane)] h-full w-1.5 translate-x-1/2 cursor-col-resize ${FOCUS_RING_CLASS}`}
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
      {/* The Extensions drawer (app shell, 2026-09-05): the five ruled
          rows — Sprints, Design, Plugins, Skills, Agent CLIs — that the top-nav
          band above the tree used to hold. The app rail's Extensions glyph
          shows it in place of the tree, and it STAYS while the card region
          swaps: a door that is one of its rows renders its own rail beside its
          canvas rather than taking this column (`railPlacement: 'inline'`).
          Only Sprints, whose rail is its own list of runs, still swaps in.
          Unmounted rather than hidden — unlike the tree it keeps no fold or
          scroll state worth preserving across a section switch. */}
      {extensionsSection && !contextRailActive ? (
        <ExtensionsRail collapsed={sidebarCollapsed} />
      ) : null}
      {/* `mb-2` where a hairline used to be (owner, 2026-09-07): the rule under
          New chat boxed the one control into a strip of its own, and the tree
          below it is separated by the space, not by a line — the same call
          as the account cluster at the rail's foot. */}
      <div className={`mx-2 mb-2 mt-1 flex flex-col gap-1.5 ${homeHidden ? 'hidden' : ''}`}>
        {/* Home's one control above the tree: New chat, the one way in (owner,
            2026-09-04). The doors that used to share this band — Sprints,
            Backlog, Reviews — live under the app rail's Extensions
            glyph now, so the tree starts one row down. The row keeps the
            tab-extract drop target. */}
        <div className="flex items-stretch gap-px">
          <Tooltip content="New chat" placement="right" wrapperClassName="flex min-w-0 flex-1">
            {/* The same nav row `SidebarNavButton` draws, and `selected` is the
                drop highlight — a transient target, so `aria-current` is
                explicitly withheld: this row is not somewhere you are. */}
            <RowButton
              density="nav"
              selected={tabDropTarget?.kind === 'new'}
              aria-current={undefined}
              onClick={onNewChat}
              onDragOver={handleTabDragOverNew}
              onDragLeave={handleTabDragLeaveNew}
              onDrop={handleTabDropOnNew}
              className="min-w-0 flex-1 text-heading font-medium"
            >
              <NewChatIcon className="icon-sm pointer-events-none shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {tabDropTarget?.kind === 'new' ? 'Drop to extract' : 'New chat'}
              </span>
            </RowButton>
          </Tooltip>
        </div>
      </div>


      {/* Tree: Starred first, then folder groups directly — no "Projects"
          umbrella header; the folder headers are the top level (Cursor-parity).
          Projects and human workspaces only: a sprint run is not a row here
          (item 1767, mockup §1) — the Sprints door lists every run across every
          project, and jumps into a run's terminals from its canvas.

          Alignment grid, re-measured in situ 2026-08-05 (MC-2101). This comment
          used to claim 36px for all four families; it was computing with icon
          sizes that had since moved, and three of the four had drifted apart:

            workspace-row content  mx-1.5 + 4px rail + pl-[26px]      = 36px
            fold row chevron       mx-1.5 + pl-[30px]                 = 36px
            section-header labels  pl-4 + 16px icon slot + gap-1.5    = 38px
            top-nav labels         mx-2 + px-2 + 16px icon + gap-2    = 40px

          36px is the grid of record — it is what the row families carry, and
          what the door rails were ruled onto (design-system/patterns/
          context-rail.html, "The alignment grid"), so a drill-in swaps the
          column without moving its text edge. The 38/40px families are recorded
          drift, not a second grid to build to; closing them is its own change.
          Keep these in step when touching any one, and re-measure rather than
          trusting the arithmetic above — that is exactly how it went stale.

          MC-2135's ruling C briefly opened each workspace row with a 16px
          identity slot, pushing row TITLES to 36 + 16 + gap-2 = 60px. The owner
          reversed that on 2026-09-02: the row has no icon, so its title is back
          on the 36px grid and aligns with the fold-row chevron again. The
          identity slot survives one level up, on the folder header, where it
          sits in the section-header family's 38px column. */}
      <nav
        ref={treeRef}
        className={`flex-1 overflow-y-auto pb-2 ${homeHidden ? 'hidden' : ''}`}
        role="tree"
        onScroll={(event) => {
          treeScrollTopRef.current = event.currentTarget.scrollTop
        }}
      >
        {starredWorkspaces.length > 0 ? (
          <section className="relative pt-1" aria-label="Starred workspaces">
            {/* The kit's nav row. `group/folder` is the hover scope the icon
                slot below reads, and the insets are the tree's own grid. */}
            <RowButton
              density="nav"
              onClick={() => setStarredCollapsed((prev) => !prev)}
              aria-expanded={!starredCollapsed}
              aria-controls="ws-starred-body"
              className="group/folder relative select-none pl-4 pr-2"
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
            </RowButton>
            <div id="ws-starred-body" hidden={starredCollapsed}>
              {!starredCollapsed
                ? starredWorkspaces.map((workspace) =>
                    renderWorkspaceRow(workspace, keyOf(workspace), { keyPrefix: 'starred-' })
                  )
                : null}
            </div>
          </section>
        ) : null}
        {/* The Remote band (remote-sessions-in-the-sidebar): the sessions that
            live on paired machines, one machine line each, placed like Starred
            — above the folders, one icon slot, collapsible. Machine management
            is not here (epic decision 3): Settings → Remote and the top bar's
            Remote glyph add, forget, and revoke. */}
        {remoteItems.length > 0 ? (
          <section className="relative pt-1" aria-label="Remote sessions">
            {/* Starred's row, same shape. */}
            <RowButton
              density="nav"
              onClick={() => setRemoteCollapsed((prev) => !prev)}
              aria-expanded={!remoteCollapsed}
              aria-controls="ws-remote-body"
              className="group/folder relative select-none pl-4 pr-2"
            >
              {/* Starred's one-slot idiom: the machine glyph at rest, the
                  collapse chevron swapped in on hover. */}
              <span className="relative flex size-icon-sm shrink-0 items-center justify-center">
                <RemoteMachineGlyph className="icon-sm shrink-0 text-[color:var(--text-muted)] transition-opacity group-hover/folder:opacity-0" />
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                  className={`icon-xs absolute inset-0 m-auto text-[color:var(--text-muted)] opacity-0 transition-[opacity,transform] group-hover/folder:opacity-100 ${
                    remoteCollapsed ? '-rotate-90' : ''
                  }`}
                >
                  <path d="M5 6L8 9L11 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="min-w-0 flex-1 truncate text-heading font-semibold text-[color:var(--text-strong)]">
                Remote
              </span>
            </RowButton>
            <div id="ws-remote-body" hidden={remoteCollapsed}>
              {/* One flat list in activity order, no machine lines and no
                  "No sessions open" (owner ruling 2026-09-05): the glyph on
                  each row says where it lives, and a band with nothing to
                  open is not drawn at all. Rows from an earlier read on a
                  machine that is not answering now are kept, drawn quieter,
                  still openable — the attach itself says whether it answers. */}
              {!remoteCollapsed
                ? remoteItems.map((item) => {
                    const node =
                      item.kind === 'workspace'
                        ? renderWorkspaceRow(item.workspace, `remote:${item.machineName}`, {
                            keyPrefix: 'remote-',
                            remoteMachine: item.machineName,
                          })
                        : renderRemoteSessionRow(item.row, item.machineName)
                    return item.stale ? (
                      <div key={item.key} className="opacity-60">
                        {node}
                      </div>
                    ) : (
                      <React.Fragment key={item.key}>{node}</React.Fragment>
                    )
                  })
                : null}
            </div>
          </section>
        ) : null}
        {chatListView === 'all' ? renderChatStream() : activeGroups.map((group) => renderFolderSection(group))}
      </nav>
      {/* The account + Settings cluster that used to pin to this column's foot
          lives at the foot of the app rail now (AppRail's accountSlot): it belongs to the window, not to whichever
          section this column happens to be showing. */}


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
            // The item says "New chat in project", and the project is the
            // header this row files under — for a worktree row, the checkout
            // it was cut from, not the worktree itself. One rule decides both
            // whether the item is offered and where it goes.
            const newChatTarget = newChatProjectTarget(workspace)
            if (action === 'new-chat' && newChatTarget) {
              onNewChatInFolder(newChatTarget)
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
            if (action === 'toggle-settle') {
              if (isSettledWorkspace(workspace)) setWorkspaceSettled(workspace.id, false)
              else settleWorkspaceById(workspace.id)
              setContextMenu(null)
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
          projectColorKey={projectKeyOf(folderMenu.folderKey)}
          projectColorSettled={projectKeySettled(folderMenu.folderKey)}
          projectColor={projectColors[projectKeyOf(folderMenu.folderKey) ?? ''] ?? null}
          onPickProjectColor={(color) => {
            const key = projectKeyOf(folderMenu.folderKey)
            if (key) setProjectColor(key, color)
            setFolderMenu(null)
          }}
          onClose={() => setFolderMenu(null)}
          onSelect={(action) => {
            const group = groups.find((g) => g.key === folderMenu.folderKey)
            setFolderMenu(null)
            if (!group) return
            if (action === 'new-chat' && group.fullPath && !group.missing) {
              onNewChatInFolder(group.fullPath)
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
        size="confirm"
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
        size="confirm"
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
        size="confirm"
      >
        {confirmForget ? (
          (() => {
            const group = groups.find((g) => g.fullPath === confirmForget)
            // Forgetting a folder closes its LOCAL rows; a paired machine's
            // clone filed under it keeps its own machine header afterwards,
            // so it is not counted as something this closes.
            const count = group?.workspaces.filter((workspace) => !workspace.remoteOrigin).length ?? 0
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
        size="confirm"
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
  | 'reveal'
  | 'move-to-new-window'
  | 'move-to-main-window'
  | 'close'
  | 'delete'
  | 'cancel-sprint'
  | 'toggle-star'
  | 'toggle-settle'
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
  // Reveal is about THIS row's folder, so a missing one takes it away. New
  // chat is about the project the row files under, which a pruned worktree
  // does not touch — hence the two predicates rather than one.
  const folderPathExists = Boolean(workspace.folderPath) && !workspace.folderMissing
  const canNewChatInProject = newChatProjectTarget(workspace) !== null
  const starred = isStarred(workspace.highlight)
  const settled = isSettledWorkspace(workspace)
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
      {canNewChatInProject ? (
        <MenuItem onClick={() => onSelect('new-chat')}>New chat in project</MenuItem>
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
      {/* Rest by hand (settled-chats, 2026-09-07). Un-settle also holds the
          row out of the sweep until it sees new activity. A row born on a
          paired machine is the Remote band's, which has no shelf. */}
      {workspace.remoteOrigin ? null : (
        <MenuItem onClick={() => onSelect('toggle-settle')}>{settled ? 'Un-settle' : 'Settle'}</MenuItem>
      )}
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

type FolderMenuAction = 'new-chat' | 'reveal' | 'forget'

function FolderContextMenu({
  x,
  y,
  group,
  projectColorKey: colorKey,
  projectColorSettled,
  projectColor,
  onClose,
  onSelect,
  onPickProjectColor,
}: {
  x: number
  y: number
  group: FolderGroup | null
  /** The project this header names, or null when it is not a project. */
  projectColorKey: string | null
  /** Whether that key is the project's FINAL one — see `canPickColor` below. */
  projectColorSettled: boolean
  /** What is stored for that project: a hue, `'none'`, or null for unseen. */
  projectColor: ProjectColorSetting | null
  onClose: () => void
  onSelect: (action: FolderMenuAction) => void
  onPickProjectColor: (color: ProjectColorSetting) => void
}) {
  if (!group) return null
  const canReveal = Boolean(group.fullPath) && !group.missing
  const canForget = Boolean(group.fullPath)
  const canCreateWorkspace = Boolean(group.fullPath) && !group.missing
  // "Changed by you" (decision 5) — but only where there is a project to
  // change, and only once we know which project it IS. The "No folder" bucket
  // is not a project, and a remote group's root lives on another machine with
  // no identity to key by.
  //
  // The `settled` half is not cosmetic. Before the repository read lands the key
  // is the folder's PATH; a person who right-clicks a header in that first
  // second and picks a hue would have it written to `folder:/path`, and a beat
  // later the project is keyed `repo:…` and their choice has silently vanished
  // — leaving the phantom path key holding one of six hues for ever. Better to
  // not offer the control for that beat than to take a choice and lose it.
  const canPickColor = Boolean(colorKey) && projectColorSettled

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
      {canReveal ? <MenuItem onClick={() => onSelect('reveal')}>Reveal folder</MenuItem> : null}
      {/* The same swatch control the row menu spends on "Highlight color", one
          menu up: a highlight is a tint a person puts ON a chat, a project
          colour is what the project IS, and the header is the one line that
          names the project. Six hues plus "No colour" — the last for a project
          whose own logo already identifies it. */}
      {canPickColor ? (
        <ProjectColorSwatchRow
          label="Project color"
          value={projectColor}
          onPick={onPickProjectColor}
        />
      ) : null}
      {canCreateWorkspace && canForget ? <MenuDivider /> : null}
      {canForget ? (
        <MenuItem variant="danger" onClick={() => onSelect('forget')}>
          Forget folder…
        </MenuItem>
      ) : null}
    </ContextMenu>
  )
}
