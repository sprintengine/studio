import type { RepositoryIdentity } from '../../../../../shared/repository-identity'
import type {
  FleetBrowse,
  FleetConnection,
  FleetLiveAttachment,
  FleetMachineReachability,
  FleetTerminal,
} from '../../../../../shared/tailnet-fleet'
import type { Workspace } from '../../../types/workspace'
import type { Tone } from '../../ui'
import { fleetMachinePhase, type FleetMachinePhase } from '../../remote/machineRowModel'
import { fleetTerminalStatus, fleetTerminalTitle } from '../../panels/fleet/fleetModel'

// The sidebar's Remote band (remote-sessions-in-the-sidebar): the sessions
// that live on each paired machine, as rows a person can open here. DOM-free,
// so the rules — which sessions are rows, which row is already open in this
// app, when a machine may be asked — are tested without mounting the tree.
//
// Decision 1 of the epic: a remote session lives here and only here. A
// workspace with `remoteOrigin` (a chat started over there from New chat, or
// a session opened from this band) is the SAME row as the session it
// attaches to — never a second row under a local folder.

/** One machine's last read, as the hook holds it. */
export type RemoteBrowseEntry = {
  /** The newest browse that answered. Kept across a machine going quiet, so its rows stay on screen dimmed. */
  browse: FleetBrowse | null
  loading: boolean
  /** Why the newest read did not answer; null when it did. */
  error: string | null
  /** Epoch ms of the newest read that settled, or null before the first. */
  at: number | null
}

/** A session on a paired machine, as the band draws it. */
export type RemoteSessionRow = {
  key: string
  connectionId: string
  machineName: string
  sessionId: string
  kind: 'agent' | 'terminal'
  title: string
  cli: string | null
  /** The remote workspace: its id, name, and folder there, and which repository that is. */
  workspaceId: string | null
  workspaceName: string | null
  workspaceRoot: string | null
  repository: RepositoryIdentity | null
  branch: string | null
  additions: number
  deletions: number
  diffScope: 'worktree' | 'branch' | 'folder'
  /** The pty is running and not paused — the row a keystroke reaches. */
  live: boolean
  status: { label: string; tone: Tone }
  /** The workspace here whose pane is attached to this session, when one is. */
  attachedWorkspaceId: string | null
}

/** One paired machine's sub-group in the band. */
export type RemoteMachineGroup = {
  key: string
  /** Null when the pairing is gone but rows born on it remain — they still need a home. */
  connectionId: string | null
  machineName: string
  phase: FleetMachinePhase | null
  rows: RemoteSessionRow[]
  /**
   * Remote-born workspaces here whose session the machine did not list: the
   * pane closed and the session ended, or the machine is not answering and
   * has never been read. They keep their row so nothing a person made vanishes.
   */
  parked: Workspace[]
  /** Why there are no rows, when that is a fact worth stating (a scope gap, a refused read). */
  notice: string | null
  /** The rows are from an earlier read and the machine is not answering now. */
  stale: boolean
  loading: boolean
}

/** What opening a row asks the app to do: focus the attached workspace, or attach a new one. */
export type RemoteSessionOpenSpec = {
  connectionId: string
  machineName: string
  sessionId: string
  title: string
  cli: string | null
  workspaceId: string | null
  workspaceName: string | null
  workspaceRoot: string | null
  repository: RepositoryIdentity | null
  branch: string | null
  attachedWorkspaceId: string | null
}

/** The remote sessions a workspace's layout holds panes on, read off the fleet-terminal tabs. */
export function fleetPaneSessionsOf(workspace: Workspace): Array<{ connectionId: string; remoteSessionId: string }> {
  const panes: Array<{ connectionId: string; remoteSessionId: string }> = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const record = node as { type?: unknown; component?: unknown; config?: unknown; children?: unknown }
    if (record.type === 'tab' && record.component === 'fleet-terminal') {
      const config = record.config as { connectionId?: unknown; remoteSessionId?: unknown } | undefined
      if (typeof config?.connectionId === 'string' && typeof config.remoteSessionId === 'string') {
        panes.push({ connectionId: config.connectionId, remoteSessionId: config.remoteSessionId })
      }
    }
    if (Array.isArray(record.children)) for (const child of record.children) walk(child)
  }
  const model = workspace.layoutModel as { layout?: unknown; borders?: unknown } | undefined
  walk(model?.layout)
  if (Array.isArray(model?.borders)) for (const border of model.borders) walk(border)
  return panes
}

/**
 * The workspace here that is this remote session, if any: by the session id
 * stamped at its creation first, then by a fleet pane still in its layout
 * (rows born before the stamp existed). Two panes on one session in two
 * workspaces are two healthy attachments; the first in list order is the one
 * a click focuses.
 */
export function attachedWorkspaceFor(
  workspaces: readonly Workspace[],
  connectionId: string,
  sessionId: string
): Workspace | null {
  for (const workspace of workspaces) {
    const origin = workspace.remoteOrigin
    if (origin && origin.connectionId === connectionId && origin.sessionId === sessionId) return workspace
  }
  for (const workspace of workspaces) {
    if (fleetPaneSessionsOf(workspace).some((pane) => pane.connectionId === connectionId && pane.remoteSessionId === sessionId)) {
      return workspace
    }
  }
  return null
}

/**
 * Whether a machine may be asked right now (epic decision 2): never while
 * main's last check says it is asleep or has revoked us. A machine never
 * checked gets one read — the check and the read race at mount, and waiting
 * on the check would leave the band empty on a quiet system.
 */
export function shouldBrowse(reach: FleetMachineReachability | undefined): boolean {
  if (!reach) return true
  if (reach.unauthorized) return false
  if (reach.checkedAt === null) return true
  return reach.reachable
}

/** A session is a row while it exists: running or paused. An exited pty is not a session anyone can open. */
export function isRemoteSessionRow(terminal: FleetTerminal): boolean {
  return terminal.processAlive || terminal.suspended
}

export function remoteSessionRowOf(
  connection: FleetConnection,
  terminal: FleetTerminal,
  browse: FleetBrowse,
  workspaces: readonly Workspace[]
): RemoteSessionRow {
  const remoteWorkspace = terminal.workspaceId
    ? browse.workspaces.find((workspace) => workspace.id === terminal.workspaceId) ?? null
    : null
  const attached = attachedWorkspaceFor(workspaces, connection.id, terminal.sessionId)
  return {
    key: `${connection.id}:${terminal.sessionId}`,
    connectionId: connection.id,
    machineName: connection.machineName,
    sessionId: terminal.sessionId,
    kind: terminal.kind,
    title: fleetTerminalTitle(terminal),
    cli: terminal.cli,
    workspaceId: terminal.workspaceId,
    workspaceName: terminal.workspaceName ?? remoteWorkspace?.name ?? null,
    workspaceRoot: remoteWorkspace?.folderPath ?? null,
    repository: remoteWorkspace?.repository ?? null,
    branch: terminal.git?.branch ?? null,
    additions: terminal.git?.additions ?? 0,
    deletions: terminal.git?.deletions ?? 0,
    diffScope: terminal.git?.scope ?? 'folder',
    live: terminal.processAlive && !terminal.suspended,
    status: fleetTerminalStatus(terminal),
    attachedWorkspaceId: attached?.id ?? null,
  }
}

/** Agents before plain shells; within each, running before paused; then by name. */
function compareRows(a: RemoteSessionRow, b: RemoteSessionRow): number {
  if (a.kind !== b.kind) return a.kind === 'agent' ? -1 : 1
  if (a.live !== b.live) return a.live ? -1 : 1
  return a.title.localeCompare(b.title)
}

export function openSpecOf(row: RemoteSessionRow): RemoteSessionOpenSpec {
  return {
    connectionId: row.connectionId,
    machineName: row.machineName,
    sessionId: row.sessionId,
    title: row.title,
    cli: row.cli,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    workspaceRoot: row.workspaceRoot,
    repository: row.repository,
    branch: row.branch,
    attachedWorkspaceId: row.attachedWorkspaceId,
  }
}

const QUIET_PHASES = new Set<FleetMachinePhase['phase']>(['unreachable', 'offline', 'revoked'])

/**
 * The band: one group per paired machine, in name order, plus a group for
 * any machine whose pairing is gone but whose rows are still here.
 */
export function buildRemoteBand(input: {
  connections: readonly FleetConnection[]
  browses: ReadonlyMap<string, RemoteBrowseEntry>
  attachments: ReadonlyMap<string, FleetLiveAttachment>
  reachability: ReadonlyMap<string, FleetMachineReachability>
  workspaces: readonly Workspace[]
}): RemoteMachineGroup[] {
  const { connections, browses, attachments, reachability, workspaces } = input
  const paired = new Set(connections.map((connection) => connection.id))
  const groups: RemoteMachineGroup[] = [...connections]
    .sort((a, b) => a.machineName.localeCompare(b.machineName))
    .map((connection) => {
      const entry = browses.get(connection.id)
      const browse = entry?.browse ?? null
      const phase = fleetMachinePhase(connection.id, attachments, reachability)
      const rows = browse
        ? browse.terminals
            .filter(isRemoteSessionRow)
            .map((terminal) => remoteSessionRowOf(connection, terminal, browse, workspaces))
            .sort(compareRows)
        : []
      const attachedIds = new Set(rows.map((row) => row.attachedWorkspaceId).filter((id): id is string => id !== null))
      const parked = workspaces.filter(
        (workspace) => workspace.remoteOrigin?.connectionId === connection.id && !attachedIds.has(workspace.id)
      )
      const gap = browse?.gaps.find((part) => part.part === 'terminals')?.message ?? null
      const notice = browse?.unauthorized
        ? 'This Mac was revoked over there. Pair again from Settings → Remote.'
        : gap ?? entry?.error ?? null
      return {
        key: connection.id,
        connectionId: connection.id,
        machineName: connection.machineName,
        phase,
        rows,
        parked,
        notice,
        stale: rows.length > 0 && QUIET_PHASES.has(phase.phase),
        loading: entry?.loading ?? false,
      }
    })

  // Rows born on a machine no longer paired here: grouped by the machine
  // their provenance names, with no phase — there is nothing to ask.
  const orphans = new Map<string, Workspace[]>()
  for (const workspace of workspaces) {
    const origin = workspace.remoteOrigin
    if (!origin || paired.has(origin.connectionId)) continue
    const list = orphans.get(origin.connectionId) ?? []
    list.push(workspace)
    orphans.set(origin.connectionId, list)
  }
  for (const [connectionId, parked] of orphans) {
    groups.push({
      key: `gone:${connectionId}`,
      connectionId: null,
      machineName: parked[0]!.remoteOrigin!.machineName,
      phase: null,
      rows: [],
      parked,
      notice: null,
      stale: false,
      loading: false,
    })
  }
  return groups
}
