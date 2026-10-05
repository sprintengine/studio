import type { RepositoryIdentity } from '../../../../../shared/repository-identity'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import {
  isMeshConversationPane,
  meshConversationPresence,
  meshConversationSessionId,
  type MeshBrowse,
  type MeshConnection,
  type MeshConversation,
  type MeshMachineReachability,
} from '../../../../../shared/tailnet-mesh'
import type { Workspace } from '../../../types/workspace'
import type { Tone } from '../../ui'
import { meshMachinePhase, type MeshMachinePhase } from '../../remote/machineRowModel'

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
  browse: MeshBrowse | null
  loading: boolean
  /** Why the newest read did not answer; null when it did. */
  error: string | null
  /** Epoch ms of the newest read that settled, or null before the first. */
  at: number | null
  /**
   * The chat conversations the machine listed on the newest read that could
   * list them; absent before one has. A pairing without conversation access,
   * or a machine that does not serve them, simply has none.
   */
  conversations?: MeshConversation[]
  /**
   * The machine advertises `conversation-lifecycle`: it owns its chats' rest
   * and read state, and a row here may offer Settle. Absent before a list.
   */
  lifecycle?: boolean
}

/**
 * What a remote conversation is doing, in the local rows' vocabulary (owner
 * ruling 2026-09-05: the band reuses the marks local rows already have — the
 * working mark and elapsed, the gold surface for needs-input, a quiet time
 * for idle — and invents no dot of its own).
 */
type RemoteRowActivity = 'working' | 'needs-input' | 'idle'

/** A chat on a paired machine — one AGENT, a line on its conversation's row. */
export type RemoteSessionRow = {
  key: string
  connectionId: string
  machineName: string
  sessionId: string
  /** The conversation's agent id over there. */
  remoteAgentId: string
  /**
   * The agent's own name ("Gael Corry"), or the kind when the remote has not
   * named it. This is a LINE's name, not a row's: it used to be the row title,
   * which is why the sidebar's remote rows read as a list of strangers instead
   * of a list of conversations (owner, 2026-09-11).
   */
  title: string
  /**
   * The CHAT's title, the one its own machine's sidebar shows: the list's
   * `chatTitle`, else the browse's name for its workspace, else the agent's
   * name when the machine gives neither.
   */
  chatTitle: string
  cli: string | null
  /** The remote workspace: its id, name, and folder there, and which repository that is. */
  workspaceId: string
  workspaceName: string | null
  workspaceRoot: string | null
  repository: RepositoryIdentity | null
  status: { label: string; tone: Tone }
  activity: RemoteRowActivity
  /** Epoch ms the activity began — how long it has worked, or sat idle. Null when the remote did not say. */
  since: number | null
  /** The workspace here whose pane is attached to this session, when one is. */
  attachedWorkspaceId: string | null
  /**
   * Where the row sits: when the person last wrote to the chat, else when
   * the machine last saw it move (`lastUserMessageAt ?? updatedAt`). The same
   * rule as a local row's, so a remote row stays put until someone speaks.
   */
  recencyAt: number
  /** When the chat's agent last finished a turn, and a person last had it on screen, on any device. */
  lastTurnEndedAt: number | null
  lastVisitedAt: number | null
  /** The machine keeps this chat's rest and read state, so Settle may be offered for it. */
  lifecycle: boolean
}

/** One paired machine's sub-group in the band. */
export type RemoteMachineGroup = {
  key: string
  /** Null when the pairing is gone but rows born on it remain — they still need a home. */
  connectionId: string | null
  machineName: string
  phase: MeshMachinePhase | null
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
 * A CONVERSATION on a paired machine: one chat, and the agent in it.
 *
 * This is the unit the sidebar draws (owner, 2026-09-11): titled with its own
 * name, filed under its project like every other chat, and drawn with a line
 * per agent exactly as a local row is.
 */
export type RemoteConversation = {
  key: string
  connectionId: string
  machineName: string
  /** The chat's name over there. */
  title: string
  /** The remote workspace's id. */
  workspaceId: string
  /** The folder it stands in, on that machine's disk. */
  workspaceRoot: string | null
  repository: RepositoryIdentity | null
  /** Its agent, as the one line the row draws. Never empty. */
  agents: RemoteSessionRow[]
  /** What its agent is doing — what the row's marks report. */
  activity: RemoteRowActivity
  /** When that began, for the row's clock; null when the remote did not say. */
  since: number | null
  /** The workspace here whose pane is following it, when one is. */
  attachedWorkspaceId: string | null
  /** Read from an earlier browse on a machine that is not answering now. */
  stale: boolean
  /** Its row's place in the list; see `RemoteSessionRow.recencyAt`. */
  recencyAt: number
}

/** What opening a row asks the app to do: focus the attached workspace, or follow the chat in a new one. */
export type RemoteSessionOpenSpec = {
  /** The chat it opens, followed in the chat view. */
  conversation: { workspaceId: string; agentId: string }
  connectionId: string
  machineName: string
  sessionId: string
  title: string
  cli: string | null
  workspaceName: string | null
  workspaceRoot: string | null
  repository: RepositoryIdentity | null
  attachedWorkspaceId: string | null
}

/** The remote sessions a workspace's layout holds panes on, read off its remote conversation tabs. */
function meshPaneSessionsOf(workspace: Workspace): Array<{ connectionId: string; remoteSessionId: string }> {
  const panes: Array<{ connectionId: string; remoteSessionId: string }> = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const record = node as { type?: unknown; component?: unknown; config?: unknown; children?: unknown }
    if (record.type === 'tab' && isMeshConversationPane(record.component)) {
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
 * stamped at its creation first, then by a mesh pane still in its layout
 * (rows born before the stamp existed). Two panes on one session in two
 * workspaces are two healthy attachments; the first in list order is the one
 * a click focuses.
 */
export function attachedWorkspaceFor(
  workspaces: readonly Workspace[],
  connectionId: string,
  sessionId: string,
): Workspace | null {
  for (const workspace of workspaces) {
    const origin = workspace.remoteOrigin
    if (origin && origin.connectionId === connectionId && origin.sessionId === sessionId) return workspace
  }
  for (const workspace of workspaces) {
    if (
      meshPaneSessionsOf(workspace).some(
        (pane) => pane.connectionId === connectionId && pane.remoteSessionId === sessionId,
      )
    ) {
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
export function shouldBrowse(reach: MeshMachineReachability | undefined): boolean {
  if (!reach) return true
  if (reach.unauthorized) return false
  if (reach.checkedAt === null) return true
  return reach.reachable
}

/**
 * A chat conversation on a paired machine, as a row: the same marks a local
 * row wears — working while a turn runs, the needs-input surface while it
 * waits on an approval or a question — titled with the chat's own name.
 */
function remoteChatRowOf(
  connection: MeshConnection,
  conversation: MeshConversation,
  browse: MeshBrowse | null,
  workspaces: readonly Workspace[],
  lifecycle: boolean,
): RemoteSessionRow {
  const remoteWorkspace = browse?.workspaces.find((workspace) => workspace.id === conversation.workspaceId) ?? null
  const sessionId = meshConversationSessionId(conversation.workspaceId, conversation.agentId)
  const presence = meshConversationPresence(conversation.phase)
  const attached = attachedWorkspaceFor(workspaces, connection.id, sessionId)
  const title = conversation.title || 'Conversation'
  // The chat's own title over there is its workspace's name there; the list
  // says it fresher than the browse does, and a machine from before the list
  // carried it leaves the browse's.
  const workspaceName = conversation.chatTitle?.trim() || remoteWorkspace?.name || null
  return {
    key: `${connection.id}:${sessionId}`,
    connectionId: connection.id,
    machineName: connection.machineName,
    sessionId,
    remoteAgentId: conversation.agentId,
    title,
    chatTitle: workspaceName ?? title,
    cli: cliForConversationProvider(conversation.providerId),
    workspaceId: conversation.workspaceId,
    workspaceName,
    workspaceRoot: remoteWorkspace?.folderPath ?? null,
    repository: remoteWorkspace?.repository ?? null,
    status:
      presence === 'running'
        ? { label: 'Running', tone: 'accent' }
        : presence === 'needs-input'
          ? { label: 'Needs approval', tone: 'warn' }
          : conversation.phase === 'failed'
            ? { label: 'Failed', tone: 'error' }
            : { label: 'Done', tone: 'neutral' },
    activity: presence === 'running' ? 'working' : presence === 'needs-input' ? 'needs-input' : 'idle',
    since: conversation.updatedAt,
    attachedWorkspaceId: attached?.id ?? null,
    recencyAt: conversation.lastUserMessageAt ?? conversation.updatedAt,
    lastTurnEndedAt: conversation.lastTurnEndedAt ?? null,
    lastVisitedAt: conversation.lastVisitedAt ?? null,
    lifecycle,
  }
}

/**
 * Most recently written to first, as the local rows are (owner ruling
 * 2026-09-09: rows stay put, ordered by when I last messaged them). These
 * used to sort working first, then waiting, then idle, then by name, so a
 * remote row jumped whenever its agent started or stopped. The marks say what
 * an agent is doing; the order never does. Ties keep the order the machine
 * listed them in, which is its own sidebar's.
 */
function compareByRecency(a: { recencyAt: number }, b: { recencyAt: number }): number {
  return b.recencyAt - a.recencyAt
}

export function openSpecOf(row: RemoteSessionRow): RemoteSessionOpenSpec {
  return {
    conversation: { workspaceId: row.workspaceId, agentId: row.remoteAgentId },
    connectionId: row.connectionId,
    machineName: row.machineName,
    sessionId: row.sessionId,
    title: row.title,
    cli: row.cli,
    workspaceName: row.workspaceName,
    workspaceRoot: row.workspaceRoot,
    repository: row.repository,
    attachedWorkspaceId: row.attachedWorkspaceId,
  }
}

const QUIET_PHASES = new Set<MeshMachinePhase['phase']>(['unreachable', 'revoked'])

/**
 * The band: one group per paired machine, in name order, plus a group for
 * any machine whose pairing is gone but whose rows are still here.
 */
export function buildRemoteBand(input: {
  connections: readonly MeshConnection[]
  browses: ReadonlyMap<string, RemoteBrowseEntry>
  reachability: ReadonlyMap<string, MeshMachineReachability>
  workspaces: readonly Workspace[]
}): RemoteMachineGroup[] {
  const { connections, browses, reachability, workspaces } = input
  const paired = new Set(connections.map((connection) => connection.id))
  const groups: RemoteMachineGroup[] = [...connections]
    .sort((a, b) => a.machineName.localeCompare(b.machineName))
    .map((connection) => {
      const entry = browses.get(connection.id)
      const browse = entry?.browse ?? null
      const phase = meshMachinePhase(connection.id, reachability)
      // A chat the machine has settled has no row, as it has none in that
      // machine's own sidebar. A machine that keeps rest leaves them out of
      // its list; one whose browse says a workspace is resting is believed
      // too, for a list read before the settle landed.
      const resting = new Set(
        (browse?.workspaces ?? [])
          .filter((workspace) => typeof workspace.settledAt === 'number')
          .map((workspace) => workspace.id),
      )
      const rows = (entry?.conversations ?? [])
        .filter((conversation) => !resting.has(conversation.workspaceId))
        .map((conversation) => remoteChatRowOf(connection, conversation, browse, workspaces, entry?.lifecycle === true))
        .sort(compareByRecency)
      const attachedIds = new Set(rows.map((row) => row.attachedWorkspaceId).filter((id): id is string => id !== null))
      const parked = workspaces.filter(
        (workspace) => workspace.remoteOrigin?.connectionId === connection.id && !attachedIds.has(workspace.id),
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
 * A machine's chats as conversation rows (owner, 2026-09-11): one entry per
 * chat, carrying its agent, in the order the rows sort in.
 */
export function conversationsOf(group: RemoteMachineGroup): RemoteConversation[] {
  return group.rows.map((row) => ({
    key: `${group.machineName}:chat:${row.sessionId}`,
    connectionId: row.connectionId,
    machineName: group.machineName,
    title: row.chatTitle,
    workspaceId: row.workspaceId,
    workspaceRoot: row.workspaceRoot,
    repository: row.repository,
    agents: [row],
    activity: row.activity,
    since: row.since,
    attachedWorkspaceId: row.attachedWorkspaceId,
    stale: group.stale,
    recencyAt: row.recencyAt,
  }))
}

/**
 * The remote conversations that need a row of their own: every one across
 * every machine that no window HERE is already showing, most recently written to first.
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
  workspaces: readonly Workspace[],
): RemoteConversation[] {
  if (!listening) return []
  const rows: RemoteConversation[] = []
  for (const group of groups) {
    for (const conversation of conversationsOf(group)) {
      const attached =
        conversation.attachedWorkspaceId !== null &&
        workspaces.some((candidate) => candidate.id === conversation.attachedWorkspaceId)
      if (!attached) rows.push(conversation)
    }
  }
  return rows.sort(compareByRecency)
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
 * The tab name a remote pane wears. The machine is part of the name, not a
 * tooltip: the same message means different things on two machines, and a pane
 * that looks local while talking to another computer is the failure this has to
 * not have.
 */
export function remotePaneTabName(machineName: string, title: string): string {
  return `${title} · ${machineName}`
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
 * listener that is down says nothing about whether the mesh can be reached.
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
  workspaces: readonly Workspace[],
): ReadonlyMap<string, RemoteConversation> {
  // Remote-BORN rows only. A local project's workspace can hold a mesh pane
  // too — someone opened a conversation from another machine inside the chat
  // they were working in — and `attachedWorkspaceFor` matches it, because for the
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
