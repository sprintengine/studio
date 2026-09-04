import type { AgentPhase } from '../shared/electron-api'

/**
 * When a turn opens and closes, read from the hooks-authoritative phase
 * (the-diff-an-agent-made / checkpoint-turn-reactor).
 *
 * Pure and separate from the reactor that acts on it, because this is the one
 * decision the whole feature's correctness rests on: capture at the wrong
 * boundary and every diff is scoped to the wrong span.
 *
 * Epic decision 3 — hooks, never output. `starting` in particular opens
 * nothing: it is the lifecycle stamp every agent session is BORN carrying
 * (`createInitialAgentState`), so treating it as work would capture a baseline
 * every time a suspended terminal is resumed. That is the same trap that made
 * the sidebar's working clock start on a resume ([[agent-state-hooks-only]]).
 */

/** Phases that mean the agent is doing something on the person's behalf. */
const WORKING_PHASES: ReadonlySet<AgentPhase> = new Set<AgentPhase>(['thinking', 'tool_use'])

/**
 * Phases that mean the agent has handed control back — a finished turn.
 *
 * `stalled` counts: it is what a lost Stop frame lands a genuinely-finished
 * agent in, and the alternative is a turn that never closes and so never gets
 * its checkpoint. `awaiting_input` counts because the agent is waiting on the
 * person, which is a turn boundary from the diff's point of view even though
 * the conversation continues.
 */
const AT_REST_PHASES: ReadonlySet<AgentPhase> = new Set<AgentPhase>([
  'idle',
  'awaiting_input',
  'stalled',
])

/**
 * Phases that end a turn because the agent is GONE. A crash mid-turn must still
 * capture: the work it did before dying is exactly what someone will want to
 * look at, and there will be no later frame to close the turn.
 */
const TERMINAL_PHASES: ReadonlySet<AgentPhase> = new Set<AgentPhase>(['exited', 'failed'])

export type TurnBoundary = 'open' | 'close' | null

export function isWorkingPhase(phase: AgentPhase | undefined | null): boolean {
  return phase !== null && phase !== undefined && WORKING_PHASES.has(phase)
}

/**
 * Classify a phase transition.
 *
 * - `open`  — the agent has started working and was not working before. The
 *   reactor captures the BASELINE here: the tree as it stands before this turn
 *   touches it.
 * - `close` — the agent was working and has stopped, either by handing back or
 *   by dying. The reactor captures the turn's result.
 * - `null`  — everything else, including thinking↔tool_use churn (which must
 *   not re-open a turn already open) and any transition between rest states.
 */
export function classifyTurnBoundary(
  previous: AgentPhase | undefined | null,
  next: AgentPhase
): TurnBoundary {
  const wasWorking = isWorkingPhase(previous)
  const isWorking = WORKING_PHASES.has(next)

  if (isWorking) {
    // Churn inside one turn is not a new turn. Without this the baseline would
    // be recaptured on every tool call, and every diff would collapse to the
    // last step rather than spanning the turn.
    return wasWorking ? null : 'open'
  }
  if (!wasWorking) return null
  if (AT_REST_PHASES.has(next) || TERMINAL_PHASES.has(next)) return 'close'
  // `starting` arriving while working is a CLI restarting under us; the turn it
  // was in is over and will never be closed by anything else.
  return next === 'starting' ? 'close' : null
}
