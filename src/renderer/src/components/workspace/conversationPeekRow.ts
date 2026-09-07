import type { TerminalSessionSnapshot } from '../../../../shared/electron-api'
import type { AgentState, Workspace } from '../../types/workspace'
import type { ConversationPeekAgent, ConversationPeekIdentity } from './ConversationPeekCard'

// What a SIDEBAR ROW knows about the conversation behind it. A tab is one
// agent; a row is a CHAT, which may hold several terminals — so it resolves a
// roster of them rather than one, and the card shows one at a time with the
// roster as its selector (mockup frame 9).
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
 * Two letters for an agent's disc. The distinguishing fact in a roster is WHO,
 * not what: the agents in one chat usually share a runtime, so a row of
 * identical runtime marks would name none of them. The full name is the disc's
 * accessible name — the initials are the face, never the label.
 */
export function agentInitials(name: string): string {
  const words = name.split(/[\s\-_.]+/u).filter(Boolean)
  if (words.length === 0) return '??'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase()
}

/** A terminal's own state, in the disc's voice. */
function agentStatusOf(session: TerminalSessionSnapshot | null): ConversationPeekIdentity['status'] {
  if (!session) return { tone: 'neutral', pulse: false, label: 'Parked' }
  if (session.activity?.kind === 'working') return { tone: 'good', pulse: true, label: 'Working' }
  if (session.activity?.kind === 'failed') return { tone: 'error', pulse: false, label: 'Failed' }
  if (session.exitedAt !== null) return { tone: 'neutral', pulse: false, label: 'Exited' }
  if (session.suspended) return { tone: 'neutral', pulse: false, label: 'Paused' }
  return { tone: 'neutral', pulse: false, label: 'Idle' }
}

/**
 * Every terminal a row's card can be moved to, live first and then most
 * recently active — which is also why the roster's FIRST entry is the one
 * selected at rest. Not the first by name or by id: an arbitrary answer dressed
 * up as a considered one.
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
 */
export function rowConversationPeekRoster(input: {
  workspace: Pick<Workspace, 'remoteOrigin'> & { agents?: Record<string, AgentState> }
  sessions: ReadonlyArray<TerminalSessionSnapshot>
}): ConversationPeekAgent[] {
  const agents = input.workspace.agents
  const byId = new Map<string, { agent: ConversationPeekAgent; live: boolean; at: number }>()
  // Which agents already have a session on the roster. Deduplicating by session
  // id alone is not enough: an agent record's `cliSessionId` is the id it was
  // LAST launched under, and a relaunch mints a new one — so a stale record
  // would put the same person on the roster twice, live and parked, under one
  // name. The agent is the unit; the session is how we ask about it.
  const seenAgents = new Set<string>()

  for (const session of input.sessions) {
    if (session.kind !== 'agent') continue
    if (session.agentId) seenAgents.add(session.agentId)
    const record = session.agentId ? agents?.[session.agentId] : undefined
    const name = record?.name ?? session.agentName ?? 'Agent'
    byId.set(session.sessionId, {
      agent: {
        sessionId: session.sessionId,
        name,
        initials: agentInitials(name),
        cli: record?.cli ?? session.cli ?? null,
        model: record?.cliModel ?? null,
        status: agentStatusOf(session),
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
        agent: {
          sessionId,
          name: record.name,
          initials: agentInitials(record.name),
          cli: record.cli ?? null,
          model: record.cliModel ?? null,
          status: agentStatusOf(null),
        },
        live: false,
        at: record.cliLastExitedAt ?? 0,
      })
    }
  }

  return [...byId.values()]
    .sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1
      if (a.at !== b.at) return b.at - a.at
      return a.agent.sessionId.localeCompare(b.agent.sessionId)
    })
    .map((entry) => entry.agent)
}

/**
 * The header's status cluster. Deliberately terser than the tab's — a row is
 * read in a list of forty, and "Workspace agents working" is a sentence where
 * the tab card has room for one. Idle says how long only when the row already
 * knows; a bare "Idle" beside a chat you last touched in March says nothing.
 */
export function peekStatusOf(
  activity: ConversationPeekRowActivity,
  idleFor: string,
): ConversationPeekIdentity['status'] {
  if (activity === 'needs-input') return { tone: 'warn', pulse: false, label: 'Waiting' }
  if (activity === 'working') return { tone: 'good', pulse: true, label: 'Working' }
  if (activity === 'failed') return { tone: 'error', pulse: false, label: 'Failed' }
  if (idleFor) return { tone: 'neutral', pulse: false, label: `Idle · ${idleFor}` }
  return { tone: 'neutral', pulse: false, label: 'Idle' }
}

/**
 * Everything the row's peek says that is not a message. Null when the row has
 * no conversation to peek at.
 *
 * The name is the ROW's title, not the agent's: the card opens out of the row
 * and has to be recognisable as that row's card. Everything that varies per
 * TERMINAL — the model, the session id, the messages — belongs to the roster,
 * because the card shows one terminal at a time and the roster is what moves
 * it between them.
 *
 * No task chip here, unlike the tab: a sprint task is claimed by an agent, and
 * a row that holds three of them would be picking one of their tasks to show.
 *
 * `sessions` is every session main knows about for this row, NOT only the ones
 * with a living process — a peek is asked for most about the chat that is not
 * running.
 */
export function rowConversationPeekIdentity(input: {
  workspace: Pick<Workspace, 'name' | 'remoteOrigin'> & { agents?: Record<string, AgentState> }
  sessions: ReadonlyArray<TerminalSessionSnapshot>
  status: ConversationPeekIdentity['status']
}): ConversationPeekIdentity | null {
  const roster = rowConversationPeekRoster(input)
  if (roster.length === 0) return null
  return {
    name: input.workspace.name,
    taskId: null,
    status: input.status,
    roster,
  }
}
