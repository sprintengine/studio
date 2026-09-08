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

/**
 * What a remote conversation is doing, in the local rows' vocabulary (owner
 * ruling 2026-09-05: the band reuses the marks local rows already have — the
 * working dots and elapsed, the gold surface for needs-input, a quiet time
 * for idle — and invents no dot of its own). `paused` is the one state a
 * local row has no word for: suspended to reclaim memory, resumes on open.
 */
type RemoteRowActivity = 'working' | 'needs-input' | 'idle' | 'paused'

/** The hook phases that mean a turn is in flight. Anything else alive is idle. */
const WORKING_PHASES = new Set(['starting', 'thinking', 'tool_use', 'working'])

function remoteRowActivity(terminal: Pick<FleetTerminal, 'suspended' | 'phase'>): RemoteRowActivity {
  if (terminal.suspended) return 'paused'
  if (terminal.phase === 'awaiting_input') return 'needs-input'
  if (terminal.phase && WORKING_PHASES.has(terminal.phase)) return 'working'
  return 'idle'
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
  activity: RemoteRowActivity
  /** Epoch ms the activity began — how long it has worked, or sat idle. Null when the remote did not say. */
  since: number | null
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
  /** The rows are from an earlier read and the machine is not answering now. */
  stale: boolean
  loading: boolean
}

/**
 * One row of the band as the sidebar draws it: a conversation on a paired
 * machine, or a workspace here that was born on one. The machine rides the
 * item, not a heading — the band is one flat list, and the glyph on each row
 * says where it lives (owner ruling 2026-09-05).
 */
export type RemoteBandItem =
  | { kind: 'session'; key: string; row: RemoteSessionRow; machineName: string; stale: boolean }
  | {
      kind: 'workspace'
      key: string
      workspace: Workspace
      machineName: string
      stale: boolean
      /** The remote session this workspace is attached to, when the machine listed it. */
      row: RemoteSessionRow | null
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
function fleetPaneSessionsOf(workspace: Workspace): Array<{ connectionId: string; remoteSessionId: string }> {
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

/**
 * A conversation is a row while it exists: an agent session, running or
 * paused. An exited pty is not a session anyone can open, and a plain shell
 * is not a conversation (owner ruling 2026-09-05): the band lists the agents
 * a person can read and talk to, not every pty the other machine holds.
 */
function isRemoteSessionRow(terminal: FleetTerminal): boolean {
  return terminal.kind === 'agent' && (terminal.processAlive || terminal.suspended)
}

function remoteSessionRowOf(
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
    activity: remoteRowActivity(terminal),
    since: terminal.phaseSince,
    attachedWorkspaceId: attached?.id ?? null,
  }
}

const ACTIVITY_RANK: Record<RemoteRowActivity, number> = { working: 0, 'needs-input': 1, idle: 2, paused: 3 }

/** Activity order, like the local rows: working, then waiting for a person, then idle, then paused; then by name. */
function compareRows(a: RemoteSessionRow, b: RemoteSessionRow): number {
  const rank = ACTIVITY_RANK[a.activity] - ACTIVITY_RANK[b.activity]
  if (rank !== 0) return rank
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
      // No notices (owner ruling 2026-09-05). A transport error, a scope
      // the pairing lacks, a revocation: none of it is a sidebar sentence.
      // The band lists conversations and nothing else; the Remote glyph
      // and Settings → Remote are where a machine's state is read.
      return {
        key: connection.id,
        connectionId: connection.id,
        machineName: connection.machineName,
        phase,
        rows,
        parked,
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
      stale: false,
      loading: false,
    })
  }
  return groups
}

/**
 * The band as one flat list (owner ruling 2026-09-05): no machine headings,
 * every row leading with the machine glyph. In activity order across
 * machines, the way the local rows sort; workspaces here whose session the
 * machine did not list come last, since nothing is happening in them.
 *
 * `listening` is whether this device is on the tailnet at all. Off it, nothing
 * over there can be reached, so nothing read from over there is drawn — only
 * the rows that are windows open HERE stay, since closing those is the
 * person's call. Nothing is forgotten: the browse rows return with the link.
 */
export function remoteBandItems(
  groups: readonly RemoteMachineGroup[],
  listening: boolean,
  workspaces: readonly Workspace[]
): RemoteBandItem[] {
  const live: Array<RemoteBandItem & { row: RemoteSessionRow }> = []
  const parked: RemoteBandItem[] = []
  for (const group of groups) {
    for (const row of group.rows) {
      const workspace = row.attachedWorkspaceId
        ? workspaces.find((candidate) => candidate.id === row.attachedWorkspaceId) ?? null
        : null
      if (workspace) {
        live.push({ kind: 'workspace', key: `ws:${workspace.id}`, workspace, machineName: group.machineName, stale: group.stale, row })
      } else if (listening) {
        live.push({ kind: 'session', key: row.key, row, machineName: group.machineName, stale: group.stale })
      }
    }
    for (const workspace of group.parked) {
      parked.push({ kind: 'workspace', key: `ws:${workspace.id}`, workspace, machineName: group.machineName, stale: group.stale, row: null })
    }
  }
  live.sort((a, b) => compareRows(a.row, b.row))
  return [...live, ...parked]
}
