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

/** A session on a paired machine — one AGENT, a line on its conversation's row. */
export type RemoteSessionRow = {
  key: string
  connectionId: string
  machineName: string
  sessionId: string
  kind: 'agent' | 'terminal'
  /**
   * The agent's own name ("Gael Corry"), or the kind when the remote has not
   * named it. This is a LINE's name, not a row's: it used to be the row title,
   * which is why the sidebar's remote rows read as a list of strangers instead
   * of a list of conversations (owner, 2026-09-11).
   */
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
 * A CONVERSATION on a paired machine: the remote workspace, and every agent
 * standing in it.
 *
 * This is the unit the sidebar draws (owner, 2026-09-11). Before it, a row was
 * one remote SESSION titled with that session's agent name — so a machine
 * running nine agents produced nine rows called "Gael Corry", "Liam Slane",
 * "Agent", with no way to tell which chat or which project any of them was.
 * A conversation is titled with its own name, files under its project like
 * every other chat, and grows a line per agent exactly as a local row does.
 */
export type RemoteConversation = {
  key: string
  connectionId: string
  machineName: string
  /** The chat's name over there. Falls back to the lone agent's name on a remote that sent none. */
  title: string
  /** The remote workspace's id; null for a session the remote filed under no workspace. */
  workspaceId: string | null
  /** The folder it stands in, on that machine's disk. */
  workspaceRoot: string | null
  repository: RepositoryIdentity | null
  /** Every agent in it, in activity order. Never empty. */
  agents: RemoteSessionRow[]
  /** The loudest thing any of its agents is doing — what the row's marks report. */
  activity: RemoteRowActivity
  /** When that began, for the row's clock; null when the remote did not say. */
  since: number | null
  /** The workspace here whose pane is attached to one of its agents, when one is. */
  attachedWorkspaceId: string | null
  /** Read from an earlier browse on a machine that is not answering now. */
  stale: boolean
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

/** The loudest thing happening in a conversation is what its row reports. */
function loudest(agents: readonly RemoteSessionRow[]): RemoteSessionRow {
  return [...agents].sort(compareRows)[0]!
}

/**
 * A machine's sessions folded into the conversations they stand in
 * (owner, 2026-09-11): one entry per remote workspace, carrying every agent in
 * it. A session the remote filed under no workspace is its own conversation —
 * there is nothing to fold it into, and dropping it would lose a chat.
 */
export function conversationsOf(group: RemoteMachineGroup): RemoteConversation[] {
  const byWorkspace = new Map<string, RemoteSessionRow[]>()
  for (const row of group.rows) {
    // No workspace id: keyed by the session, so it stands alone rather than
    // pooling every folderless session on the machine into one fake chat.
    const key = row.workspaceId ?? `session:${row.sessionId}`
    const list = byWorkspace.get(key) ?? []
    list.push(row)
    byWorkspace.set(key, list)
  }
  const conversations: RemoteConversation[] = []
  for (const [key, rows] of byWorkspace) {
    const agents = [...rows].sort(compareRows)
    const lead = loudest(agents)
    conversations.push({
      key: `${group.machineName}:${key}`,
      connectionId: lead.connectionId,
      machineName: group.machineName,
      // The chat's name, and only if the remote has one to give. The lone
      // agent's name is the fallback rather than the first choice — it is the
      // best a remote that predates `workspaceName` can do, not the title.
      title: lead.workspaceName?.trim() || lead.title,
      workspaceId: lead.workspaceId,
      workspaceRoot: lead.workspaceRoot,
      repository: lead.repository,
      agents,
      activity: lead.activity,
      since: lead.since,
      attachedWorkspaceId: agents.find((row) => row.attachedWorkspaceId)?.attachedWorkspaceId ?? null,
      stale: group.stale,
    })
  }
  return conversations
}

/** Conversations sort the way rows do: by what their loudest agent is doing. */
function compareConversations(a: RemoteConversation, b: RemoteConversation): number {
  const rank = ACTIVITY_RANK[a.activity] - ACTIVITY_RANK[b.activity]
  if (rank !== 0) return rank
  return a.title.localeCompare(b.title)
}

/**
 * The remote conversations that need a row of their own: every one across
 * every machine that no window HERE is already showing, in activity order.
 *
 * A conversation whose session a local workspace is attached to is not in this
 * list, and must not be: that workspace is already a row of its project
 * (`remoteOrigin`), and listing it here too would be the same chat twice.
 *
 * `listening` is whether this device is on the tailnet at all. Off it, nothing
 * over there can be reached, so nothing read from over there is drawn — only
 * the rows that are windows open HERE stay, since closing those is the
 * person's call. Nothing is forgotten: the browse rows return with the link.
 */
export function unattachedConversations(
  groups: readonly RemoteMachineGroup[],
  listening: boolean,
  workspaces: readonly Workspace[]
): RemoteConversation[] {
  if (!listening) return []
  const rows: RemoteConversation[] = []
  for (const group of groups) {
    for (const conversation of conversationsOf(group)) {
      const attached =
        conversation.attachedWorkspaceId !== null
        && workspaces.some((candidate) => candidate.id === conversation.attachedWorkspaceId)
      if (!attached) rows.push(conversation)
    }
  }
  return rows.sort(compareConversations)
}

/** What opening a conversation attaches to: its loudest agent — the one you came for. */
export function openSpecOfConversation(conversation: RemoteConversation): RemoteSessionOpenSpec {
  return openSpecOf(conversation.agents[0]!)
}

/**
 * What a chat opened from — or started on — a paired machine is CALLED here.
 *
 * The remote chat's own name, and the lone agent's only when the remote had no
 * name to give (owner, 2026-09-13: "we shouldn't show 'Tara Boyle · xxx' — the
 * agent name shouldn't be there, it is not relevant"). It used to be
 * `${agentName} · ${chatName}`, which put a stranger's name in front of every
 * remote row and made a list of chats read as a list of people — the same
 * mistake the band's own rows made until `conversationsOf` stopped titling a
 * conversation with its loudest agent. One rule, both paths.
 */
export function remoteWorkspaceName(agentTitle: string, remoteChatName: string | null | undefined): string {
  return remoteChatName?.trim() || agentTitle
}

/**
 * A remote-born row's title, for rows that already exist.
 *
 * `workspace.name` is the answer, except for the rows minted under the old
 * `${agentName} · ${chatName}` rule: those are already in people's stores and
 * would keep reading as strangers forever. A name that ends in exactly its own
 * provenance's chat name, with something in front of it, IS one of those, and
 * the chat name is what it should have been called. A person who renamed the
 * row themselves keeps their name — unless they happened to type that exact
 * shape, in which case they get the chat's name, which is not a bad one.
 */
export function remoteConversationTitle(workspace: Pick<Workspace, 'name' | 'remoteOrigin'>): string {
  const chatName = workspace.remoteOrigin?.workspaceName?.trim()
  if (!chatName) return workspace.name
  const suffix = ` · ${chatName}`
  if (workspace.name.length > suffix.length && workspace.name.endsWith(suffix)) return chatName
  return workspace.name
}

/**
 * Whether THIS device is on the tailnet, as the sidebar must answer it.
 *
 * Three answers rather than two, because "we have not been told" is a real
 * state and must not read as "disconnected": a host without the tailnet bridge
 * (a narrower preload, a partial test harness) and the moment before the first
 * status read both have `status === null`, and hiding every remote row on
 * those would empty the sidebar of chats that are perfectly fine.
 *
 * `tailnetAddress` is the signal rather than `running`, which is the INBOUND
 * listener's state: a person can drive paired machines with Remote turned off
 * here — the listener is what lets other machines drive THIS one — so a
 * listener that is down says nothing about whether the fleet can be reached.
 * An address out of Tailscale's own ranges sits on an interface only while
 * Tailscale is up (`resolveTailnetInterface`), which is exactly the question.
 */
export type RemoteLinkState = 'unknown' | 'up' | 'down'

export function remoteLinkStateOf(status: { tailnetAddress: string | null } | null | undefined): RemoteLinkState {
  if (!status) return 'unknown'
  return status.tailnetAddress === null ? 'down' : 'up'
}

/**
 * The conversation each OPEN remote row is, keyed by the workspace here that
 * holds it (owner, 2026-09-13).
 *
 * The complement of {@link unattachedConversations}: that one lists the
 * conversations no window here holds, this one names the ones that ARE windows
 * here. A remote-born workspace's own layout knows about exactly one session —
 * the pane it attached — so left to itself its row draws one inert line for a
 * chat that may have nine agents standing in it. The browse already read all
 * nine; this is how the row gets to draw them, the way a local chat running
 * three terminals draws three lines.
 */
export function attachedConversations(
  groups: readonly RemoteMachineGroup[],
  workspaces: readonly Workspace[]
): ReadonlyMap<string, RemoteConversation> {
  // Remote-BORN rows only. A local project's workspace can hold a fleet pane
  // too — someone opened a terminal from another machine inside the chat they
  // were working in — and `attachedWorkspaceFor` matches it, because for the
  // band's purposes it genuinely is the window showing that session. It is not
  // a remote conversation, though: it is a local chat with a visitor in it, and
  // handing this map its id would replace its own agents' lines with the other
  // machine's.
  const remoteBorn = new Set(workspaces.filter((workspace) => workspace.remoteOrigin).map((workspace) => workspace.id))
  const byWorkspace = new Map<string, RemoteConversation>()
  for (const group of groups) {
    for (const conversation of conversationsOf(group)) {
      const id = conversation.attachedWorkspaceId
      if (id && remoteBorn.has(id)) byWorkspace.set(id, conversation)
    }
  }
  return byWorkspace
}
