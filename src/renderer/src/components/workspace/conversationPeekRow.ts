import type { TerminalSessionSnapshot } from '../../../../shared/electron-api'
import type { AgentState, Workspace } from '../../types/workspace'
import type { ConversationPeekIdentity } from './ConversationPeekCard'

// What a SIDEBAR ROW knows about the conversation behind it. A tab is one
// agent, so its identity is a lookup; a row is a chat, which may hold several
// terminals, so it has to choose one — and the choice has to be the same one
// every time or the card would describe a different agent on each hover.
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
 * The session a row's peek reads. Agent sessions only — a plain shell has no
 * conversation — living ones ahead of exited ones, then most recently active
 * first, then by id so two sessions that tie never swap between renders.
 *
 * The live-before-exited arm is load-bearing now that the caller hands over
 * every session main knows about rather than only the running ones: a chat with
 * a finished agent and a running one shows the running one's conversation.
 *
 * A row whose only terminals are shells, or that has none at all, returns null
 * and falls through to {@link parkedPeekAgentOf}.
 */
export function peekSessionOf(
  sessions: ReadonlyArray<TerminalSessionSnapshot>,
): TerminalSessionSnapshot | null {
  const agents = sessions.filter((session) => session.kind === 'agent')
  if (agents.length === 0) return null
  return [...agents].sort((a, b) => {
    const aLive = a.exitedAt === null ? 0 : 1
    const bLive = b.exitedAt === null ? 0 : 1
    if (aLive !== bLive) return aLive - bLive
    const at = activityAt(b) - activityAt(a)
    if (at !== 0) return at
    return a.sessionId.localeCompare(b.sessionId)
  })[0]
}

/**
 * A PARKED chat's agent — the case the peek exists for, and the one it could
 * not answer until now.
 *
 * Main only lists a session while a process or a suspended placeholder holds
 * it, and it rehydrates a sidecar lazily, when a terminal is actually opened.
 * So after a restart the sidebar is mostly rows main's session list has never
 * heard of — and those are exactly the chats a person hovers to ask "what was
 * this one about?". The durable id is the agent record's own `cliSessionId`:
 * the terminal-tracking key, persisted in the workspace registry, and the same
 * id `terminalStatus` is already asked about. Main keys the snapshot sidecar on
 * it, so handing it over is enough for a parked chat to answer from its
 * transcript.
 *
 * Two gates, and both are about not opening a card that can only say nothing:
 *
 * - `cliSessionId` — no id, nothing to ask about.
 * - `cliHasLaunched` — a chat whose agent has never started has no transcript
 *   and no sidecar, by construction. Main would answer `none` for it, and the
 *   card would then say this runtime does not report its messages about a
 *   Claude Code chat that simply has not run yet.
 *
 * Ordered by when each agent's CLI last exited, newest first, then by id: the
 * agent you were last working with is the one a parked chat is about.
 */
export function parkedPeekAgentOf(
  agents: Record<string, AgentState> | undefined,
): AgentState | null {
  const eligible = Object.values(agents ?? {}).filter(
    (agent) => Boolean(agent.cliSessionId) && agent.cliHasLaunched === true,
  )
  if (eligible.length === 0) return null
  return [...eligible].sort((a, b) => {
    const at = (b.cliLastExitedAt ?? 0) - (a.cliLastExitedAt ?? 0)
    if (at !== 0) return at
    return (a.cliSessionId ?? '').localeCompare(b.cliSessionId ?? '')
  })[0]
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
 * and has to be recognisable as that row's card. The model and runtime come
 * from the agent record where there is one, falling back to what the session
 * itself reports — a headless-launched agent has a session before the renderer
 * has a record for it.
 *
 * No task chip here, unlike the tab: a sprint task is claimed by an agent, and
 * a row that holds three of them would be picking one of their tasks to show.
 *
 * A chat that holds more than one agent says so (`agentScope`). Everything else
 * on the card — the model, the session, the messages — belongs to the ONE agent
 * picked above, and under the chat's own name that reads as the whole
 * conversation. Naming the agent and the count is the least that stops it
 * lying; the roster and the merged thread are a later pass.
 *
 * `sessions` is every session main knows about for this row, NOT only the ones
 * with a living process. A running agent still wins; a suspended or exited one
 * is next; and a chat main has never heard of falls through to its own agent
 * records, which is most of the sidebar after a restart.
 */
export function rowConversationPeekIdentity(input: {
  workspace: Pick<Workspace, 'name' | 'remoteOrigin'> & { agents?: Record<string, AgentState> }
  sessions: ReadonlyArray<TerminalSessionSnapshot>
  status: ConversationPeekIdentity['status']
}): ConversationPeekIdentity | null {
  const agents = input.workspace.agents
  const session = peekSessionOf(input.sessions)
  // A chat that belongs to a paired machine keeps ITS session ids, and this
  // main has no session and no sidecar under any of them — it would answer
  // "this runtime doesn't report its messages" about a perfectly ordinary
  // Claude chat on the other end. Reading a remote conversation is a different
  // feature; until it exists, a remote row's card is not offered rather than
  // wrong. A live session here is always local, so only the parked fallback
  // needs the guard.
  const parked = session || input.workspace.remoteOrigin ? null : parkedPeekAgentOf(agents)
  const agent = session
    ? session.agentId
      ? agents?.[session.agentId]
      : undefined
    : (parked ?? undefined)
  const sessionId = session?.sessionId ?? parked?.cliSessionId ?? null
  if (!sessionId) return null

  // How many agents this CHAT holds, counted once each across both sources: a
  // parked agent whose session main is still tracking is one agent, not two.
  const chatSessionIds = new Set<string>()
  for (const candidate of input.sessions) {
    if (candidate.kind === 'agent') chatSessionIds.add(candidate.sessionId)
  }
  if (!input.workspace.remoteOrigin) {
    for (const record of Object.values(agents ?? {})) {
      if (record.cliSessionId && record.cliHasLaunched === true) chatSessionIds.add(record.cliSessionId)
    }
  }

  return {
    name: input.workspace.name,
    cli: agent?.cli ?? session?.cli ?? null,
    model: agent?.cliModel ?? null,
    sessionId,
    taskId: null,
    status: input.status,
    agentScope:
      chatSessionIds.size > 1
        ? { agentName: agent?.name ?? session?.agentName ?? 'this agent', total: chatSessionIds.size }
        : null,
  }
}
