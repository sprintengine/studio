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
 * A row whose only terminals are shells, or that has none at all, returns null
 * and gets no peek: there is nothing to ask main about, and a card offering
 * only a title the row already shows is the noise this surface exists to avoid.
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
 */
export function rowConversationPeekIdentity(input: {
  workspace: Pick<Workspace, 'name'> & { agents?: Record<string, AgentState> }
  sessions: ReadonlyArray<TerminalSessionSnapshot>
  status: ConversationPeekIdentity['status']
}): ConversationPeekIdentity | null {
  const session = peekSessionOf(input.sessions)
  if (!session) return null
  const agent = session.agentId ? input.workspace.agents?.[session.agentId] : undefined
  const agentCount = input.sessions.filter((candidate) => candidate.kind === 'agent').length
  return {
    name: input.workspace.name,
    cli: agent?.cli ?? session.cli ?? null,
    model: agent?.cliModel ?? null,
    sessionId: session.sessionId,
    taskId: null,
    status: input.status,
    agentScope:
      agentCount > 1
        ? { agentName: agent?.name ?? session.agentName ?? 'this agent', total: agentCount }
        : null,
  }
}
