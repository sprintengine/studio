import type { AgentPhaseEvent, AgentSessionExitEvent } from '../shared/agent-runtime'
import type { TerminalSessionSnapshot } from '../shared/ipc/terminal'

// =============================================================================
// Keep the computer awake while agents work.
//
// An agent mid-turn is work the person walked away from on purpose: a long
// refactor, a test suite, a build. If the machine sleeps under it, the turn
// stalls until someone wakes the machine, and a CLI that lost its network in
// the meantime may not finish at all. So while any agent is working the app
// holds a `prevent-app-suspension` power-save blocker — the system may still
// turn the display off and lock the screen, it just does not sleep — and lets
// it go the moment the last one stops.
//
// "Working" is thinking or using a tool, read off the phase events agent
// attention gets (`agent-attention.ts`). `starting` is not: it is what a CLI
// reports when it opens, and a CLI left at its prompt — or a session resumed
// and never sent a message — says nothing after it. Its first prompt says
// `thinking`. Neither is a conversation's `session_closed`, which the
// attention adapter reports as a working phase so the badge clears.
//
// The phases alone can leave an agent counted with nothing running: an
// interrupt sends no turn end, and a pty that exits mid-turn sends no phase at
// all. So the phases only ADD an agent; the live state decides whether it
// stays. A pty's exit drops its agent at once (`onAgentExit`), and once a
// minute each counted agent is checked against what the runtime now says of
// it (`liveWorking`) — the terminal runtime turns a turn gone quiet into
// `stalled`, which is not working. An agent the live state does not know of
// (a chat on an out-of-process server) is dropped once it has reported
// nothing for `STALE_AGENT_MS`. Everything is let go when the app quits. The
// setting is read on every change, so turning it off releases the blocker at
// once and turning it on with agents working takes it.
//
// Electron is injected, so the rules run headless under test.
// =============================================================================

/** The slice of Electron's `powerSaveBlocker` this uses. */
export type KeepAwakeBlocker = {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
}

/**
 * What the live state says of one agent: working, not working, or `undefined`
 * when it does not know the agent. Built once per check.
 */
export type LiveWorkingLookup = (workspaceId: string | null, agentId: string) => boolean | undefined

export type AgentKeepAwakeDeps = {
  blocker: KeepAwakeBlocker
  /** The "Keep the computer awake while agents work" setting. */
  isEnabled(): boolean
  /** The runtime's live reading of its agents, asked on each check. */
  liveWorking?(): LiveWorkingLookup
  now?(): number
  setInterval?(callback: () => void, ms: number): unknown
  clearInterval?(handle: unknown): void
}

export type AgentKeepAwake = {
  onAgentPhase(event: AgentPhaseEvent): void
  /** An agent's process ended, a turn under way or not. */
  onAgentExit(event: Pick<AgentSessionExitEvent, 'workspaceId' | 'agentId'>): void
  /** The setting changed: take or release the blocker to match. */
  refresh(): void
  /** The app is quitting: forget every agent and release the blocker. */
  dispose(): void
  /** How many agents count as working. Exposed for tests. */
  workingCount(): number
  /** Whether the blocker is held. Exposed for tests. */
  isHolding(): boolean
  /** Run the periodic check now. Exposed for tests. */
  check(): void
}

const WORKING_PHASES = new Set<AgentPhaseEvent['phase']>(['thinking', 'tool_use'])

// The cap on an agent the live state cannot vouch for. Such an agent's own
// events are what end it (a chat's turn end), so this only catches one that
// went missing; long enough for one slow step that reports nothing between
// its start and its end.
export const STALE_AGENT_MS = 20 * 60 * 1000
export const CHECK_EVERY_MS = 60 * 1000

/**
 * Whether a terminal agent is working by its live state: a running, awake
 * process whose hooks put it mid-turn. `stalled` (the runtime's word for a
 * turn that went quiet, which is what an interrupt leaves) and `starting` are
 * not working.
 */
export function terminalAgentWorking(
  session: Pick<TerminalSessionSnapshot, 'processAlive' | 'suspended' | 'agentState'>,
): boolean {
  if (!session.processAlive || session.suspended) return false
  const phase = session.agentState?.phase
  return phase === 'thinking' || phase === 'tool_use'
}

// The same key agent attention counts by: an agent id is only unique within its
// workspace, so two chats' `agent-1`s are two agents.
function agentKey(workspaceId: string | null | undefined, agentId: string): string {
  return `${workspaceId ?? ''}\0${agentId}`
}

type Tracked = { workspaceId: string | null; agentId: string; seenAt: number }

export function createAgentKeepAwake(deps: AgentKeepAwakeDeps): AgentKeepAwake {
  const now = deps.now ?? Date.now
  const startTimer = deps.setInterval ?? ((callback, ms) => setInterval(callback, ms).unref())
  const stopTimer = deps.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout))
  const working = new Map<string, Tracked>()
  let blockerId: number | null = null
  let timer: unknown = null

  function sync(): void {
    const want = working.size > 0 && deps.isEnabled()
    if (want && blockerId === null) {
      try {
        blockerId = deps.blocker.start('prevent-app-suspension')
      } catch {
        // A platform that refuses the blocker just sleeps as it would have.
      }
    } else if (!want && blockerId !== null) {
      const id = blockerId
      blockerId = null
      try {
        deps.blocker.stop(id)
      } catch {
        // Already gone; nothing is held either way.
      }
    }
    // The check runs only while there is something to check.
    if (working.size > 0 && timer === null) timer = startTimer(check, CHECK_EVERY_MS)
    else if (working.size === 0 && timer !== null) {
      stopTimer(timer)
      timer = null
    }
  }

  function check(): void {
    if (working.size > 0) {
      const live = deps.liveWorking?.()
      const cutoff = now() - STALE_AGENT_MS
      for (const [key, agent] of working) {
        const verdict = live?.(agent.workspaceId, agent.agentId)
        if (verdict === false || (verdict === undefined && agent.seenAt < cutoff)) working.delete(key)
      }
    }
    sync()
  }

  function onAgentPhase(event: AgentPhaseEvent): void {
    const key = agentKey(event.workspaceId, event.agentId)
    if (WORKING_PHASES.has(event.phase) && event.event !== 'session_closed') {
      working.set(key, { workspaceId: event.workspaceId ?? null, agentId: event.agentId, seenAt: now() })
    } else working.delete(key)
    sync()
  }

  function onAgentExit(event: Pick<AgentSessionExitEvent, 'workspaceId' | 'agentId'>): void {
    if (!event.agentId) return
    if (working.delete(agentKey(event.workspaceId, event.agentId))) sync()
  }

  function dispose(): void {
    working.clear()
    sync()
  }

  return {
    onAgentPhase,
    onAgentExit,
    refresh: sync,
    dispose,
    check,
    workingCount: () => working.size,
    isHolding: () => blockerId !== null,
  }
}
