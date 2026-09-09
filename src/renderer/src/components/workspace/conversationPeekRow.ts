import { formatRelativeMs } from '../../utils/relativeTime'
import type { TerminalSessionSnapshot } from '../../../../shared/electron-api'
import type { AgentState, Workspace } from '../../types/workspace'
import type { ConversationPeekIdentity, ConversationPeekStatus } from './ConversationPeekCard'

// What a SIDEBAR ROW knows about the conversations behind it.
//
// ONE CARD PER AGENT (owner, 2026-09-09). A row is a CHAT and may hold several
// terminals, so this resolves ONE IDENTITY PER TERMINAL rather than a roster
// the card selects from: the sidebar already lists a chat's agents as its own
// sub-lines, and the person points at the one they mean. The shell picks the
// identity whose session the pointer is on (`data-peek-session`) and falls back
// to the first — which is the whole of a single-agent row, where the row and
// the agent are the same thing.
//
// Nothing is merged. Three terminals are three conversations that happen to
// share a folder, and a single thread stitched from all three reads as one
// conversation that never happened.
//
// Pure: props in, a value out. The row renders it; the tests read it.

/** A row's live state, in the peek header's terse voice. */
export type ConversationPeekRowActivity = 'needs-input' | 'working' | 'failed' | 'idle'

/**
 * How recently a session did anything. The same three timestamps the row's own
 * terminal lines rank on, folded to one number: a session that has never
 * spoken still sorts by when it started, so the ordering is total.
 */
function activityAt(session: TerminalSessionSnapshot): number {
  return Math.max(session.lastInputAt ?? 0, session.lastOutputAt ?? 0, session.startedAt)
}

/**
 * ONE terminal's own state, for a row that holds more than one.
 *
 * Idle says how long, from the same three timestamps the ordering uses, because
 * a bare "Idle" on a card opened from a chat you last touched in March says
 * nothing. The row's own status (see `peekStatusOf`) is better than this
 * wherever there is only one terminal — it knows about needs-input, which a
 * session snapshot alone does not — so that is what a single-agent row uses.
 */
function agentStatusOf(
  session: TerminalSessionSnapshot | null,
  now: number,
): ConversationPeekStatus {
  if (!session) return { kind: 'attention', label: 'Parked' }
  if (session.activity?.kind === 'working') return { kind: 'working', label: 'Working' }
  if (session.activity?.kind === 'failed') return { kind: 'attention', label: 'Failed' }
  if (session.exitedAt !== null) return { kind: 'idle', label: 'Exited' }
  if (session.suspended) return { kind: 'attention', label: 'Paused' }
  const idleFor = formatRelativeMs(activityAt(session), now)
  return { kind: 'idle', label: idleFor ? `Idle · ${idleFor}` : 'Idle' }
}

/**
 * The header's status cluster for the ROW as a whole. Deliberately terser than
 * the tab's — a row is read in a list of forty, and "Workspace agents working"
 * is a sentence where the tab card has room for one. Idle says how long only
 * when the row already knows; a bare "Idle" beside a chat you last touched in
 * March says nothing.
 */
export function peekStatusOf(
  activity: ConversationPeekRowActivity,
  idleFor: string,
): ConversationPeekStatus {
  if (activity === 'needs-input') return { kind: 'attention', label: 'Waiting' }
  if (activity === 'working') return { kind: 'working', label: 'Working' }
  if (activity === 'failed') return { kind: 'attention', label: 'Failed' }
  if (idleFor) return { kind: 'idle', label: `Idle · ${idleFor}` }
  return { kind: 'idle', label: 'Idle' }
}

/**
 * One card per terminal this row can peek at, live first and then most recently
 * active — which is also why the FIRST entry is the one a row with no hovered
 * agent line opens on. Not the first by name or by id: an arbitrary answer
 * dressed up as a considered one.
 *
 * Built from the two sources the peek already resolves — the sessions main
 * knows about and the row's own parked agent records — deduplicated by session
 * id, so an agent that is both a tracked session and a persisted record appears
 * once.
 *
 * Shells are not in it: a plain terminal has no conversation. Neither is an
 * agent record that has never launched — no transcript and no sidecar by
 * construction, so main would answer `none` and the card would call a Claude
 * Code chat a runtime that cannot report.
 *
 * The `live` arm is load-bearing now that the caller hands over every session
 * main knows about rather than only the running ones: a chat with a finished
 * agent and a running one opens on the running one.
 *
 * `status` is the ROW's own answer and is used only where the row holds one
 * terminal, because there the row and the agent are the same thing and the row
 * knows more (needs-input, and its own idle clock). Where there are several,
 * each card says its own agent's state — the point of the ruling.
 *
 * `sessions` is every session main knows about for this row, NOT only the ones
 * with a living process — a peek is asked for most about the chat that is not
 * running.
 *
 * Empty when the row has no conversation to peek at, which is the caller's
 * signal to draw no card at all.
 */
export function rowConversationPeekIdentities(input: {
  workspace: Pick<Workspace, 'name' | 'remoteOrigin'> & { agents?: Record<string, AgentState> }
  sessions: ReadonlyArray<TerminalSessionSnapshot>
  status: ConversationPeekStatus
  now: number
}): ConversationPeekIdentity[] {
  const agents = input.workspace.agents
  const byId = new Map<string, { identity: ConversationPeekIdentity; live: boolean; at: number }>()
  // Which agents already have a session on the list. Deduplicating by session
  // id alone is not enough: an agent record's `cliSessionId` is the id it was
  // LAST launched under, and a relaunch mints a new one — so a stale record
  // would put the same person on the list twice, live and parked, under one
  // name. The agent is the unit; the session is how we ask about it.
  const seenAgents = new Set<string>()

  for (const session of input.sessions) {
    if (session.kind !== 'agent') continue
    if (session.agentId) seenAgents.add(session.agentId)
    const record = session.agentId ? agents?.[session.agentId] : undefined
    byId.set(session.sessionId, {
      identity: {
        // The ROW's title, not the agent's: the card opens out of the row and
        // has to be recognisable as that row's card (mockup frame 3, where the
        // card opened from an agent line still names the chat).
        name: input.workspace.name,
        // No task chip on a row, unlike the tab: a sprint task is claimed by an
        // agent, and the row's own title is the chat's.
        taskId: null,
        status: agentStatusOf(session, input.now),
        agent: {
          sessionId: session.sessionId,
          // The agent, not only the session: the card's "open the diff" opens
          // that agent's changelist, and a session id is not what a list is
          // named after.
          agentId: session.agentId ?? record?.id ?? null,
          cli: record?.cli ?? session.cli ?? null,
          model: record?.cliModel ?? null,
          fileChanges: session.fileChanges ?? [],
          // What this conversation produced (epic pull-request-marks): main's
          // own union of the branch's pull requests and the ones this session
          // opened itself in any repository. Absent on an older snapshot, and
          // an absent answer draws exactly what an empty one draws.
          pullRequests: session.pullRequests ?? [],
          activeSubagents: session.activeSubagents ?? 0,
          contextUsage: session.contextUsage ?? null,
        },
      },
      live: session.exitedAt === null,
      at: activityAt(session),
    })
  }

  // Parked records, for the chats main's session list has never heard of. Never
  // for a chat that belongs to a paired machine: its ids are that machine's, and
  // this main has neither a session nor a sidecar under any of them.
  if (!input.workspace.remoteOrigin) {
    for (const record of Object.values(agents ?? {})) {
      const sessionId = record.cliSessionId
      if (!sessionId || record.cliHasLaunched !== true) continue
      if (byId.has(sessionId) || seenAgents.has(record.id)) continue
      byId.set(sessionId, {
        identity: {
          name: input.workspace.name,
          taskId: null,
          status: agentStatusOf(null, input.now),
          agent: {
            sessionId,
            agentId: record.id,
            cli: record.cli ?? null,
            model: record.cliModel ?? null,
            // A parked record is not a session: main holds no ledger for it,
            // and an empty list is the honest answer rather than a stale one.
            // Its pull requests are the same story — the record is keyed by
            // repo and branch on main's side, and this row has no session to
            // ask about.
            fileChanges: [],
            pullRequests: [],
            activeSubagents: 0,
            contextUsage: null,
          },
        },
        live: false,
        at: record.cliLastExitedAt ?? 0,
      })
    }
  }

  const ordered = [...byId.values()]
    .sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1
      if (a.at !== b.at) return b.at - a.at
      return a.identity.agent.sessionId.localeCompare(b.identity.agent.sessionId)
    })
    .map((entry) => entry.identity)

  // One terminal: the row IS the agent, so the row's own status wins — it knows
  // about needs-input, and its idle clock is the one the row is already showing.
  const only = ordered[0]
  if (ordered.length === 1 && only) return [{ ...only, status: input.status }]
  return ordered
}
