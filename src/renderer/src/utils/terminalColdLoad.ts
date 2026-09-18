// What a mounting agent terminal should DO — decided once, explicitly.
//
// Before this existed, `launchTerminal` had two outcomes: pause (only reachable
// when main held a suspended record) or spawn. There was no way to say "leave
// this tab alone", so every "don't resume it" decision elsewhere in the app
// became a fresh CLI launch by default. Persist-time clears that dropped
// `cliSessionId` to prevent auto-resume achieved it literally: the tab minted a
// new uuid, matched no session and no snapshot sidecar, so `suspended` was false,
// so the pause branch was unreachable — and it spawned.
//
// `inert` is that missing third outcome: a cold-loaded agent with nothing to
// paint sits idle until the user starts it.

export type AgentColdLoadDecision =
  /** Launch (fresh or `--resume`, per the caller's own resume flags). */
  | 'spawn'
  /** Repaint the persisted screen and stay paused; the resume thunk is armed. */
  | 'paused'
  /** Do nothing. No pty, no paint — the user starts it deliberately. */
  | 'inert'

/**
 * The launch-intent fields a mounting terminal reads. Only these three say "the
 * user wants this agent running NOW"; everything else on the
 * agent is history.
 */
export interface AgentLaunchIntentInput {
  /** Set by every deliberate start path (agent creation, AgentPanel). */
  cliStartRequested?: boolean
  /** Bumped by an explicit restart. */
  cliRestartNonce?: number
  /** An onboarding directive still waiting to be delivered. */
  cliStartupPrompt?: string
}

/**
 * Live launch intent — the signal that separates a brand-new agent from a
 * cold-loaded record.
 *
 * This is the distinction the old code could not make, and the reason `inert`
 * must NOT be inferred from "no snapshot sidecar": a newly created agent also
 * has no session id and no sidecar, and it must still spawn. What it *has* is
 * intent — a deliberate start path sets `cliStartRequested`. A persisted record
 * rehydrated at app start carries none, because the persist normalizers clear
 * exactly these fields.
 *
 * NOT intent, deliberately:
 * - `cliHasLaunched` — the persisted resume gate. Reading it here would put
 *   every cold-loaded agent that ever ran straight back into a spawn, which is
 *   the bug.
 * - A startup prompt DERIVED at render time by a host. Only the PERSISTED
 *   `cliStartupPrompt` — an
 *   onboarding directive that was never delivered — counts.
 */
export function hasLiveAgentLaunchIntent(agent: AgentLaunchIntentInput | null | undefined): boolean {
  if (!agent) return false
  return Boolean(agent.cliStartRequested) || Boolean(agent.cliStartupPrompt) || (agent.cliRestartNonce ?? 0) > 0
}

export interface AgentColdLoadInput {
  /** Reattaching an externally-owned session; identity is not ours to decide. */
  attachedSessionId?: string | null
  /** `terminal:status` — a pty is running under this session id. */
  processAlive: boolean
  /**
   * `terminal:status` — main holds a suspended record for this session id, OR
   * rehydrated one from the snapshot sidecar on disk. Either way there is a
   * painted screen to show.
   */
  suspended: boolean
  /** `hasLiveAgentLaunchIntent(agent)` for the agent as it stands right now. */
  hasLaunchIntent: boolean
  /**
   * THIS app session minted the agent's session id (`markAgentSessionMinted`),
   * so the record is new, not restored from disk.
   *
   * Load-bearing: a workspace's template agents are seeded by `defaultAgent`
   * with no session id and no launch flags, and they rely on the mounting
   * terminal to mint an id and launch. Without this signal they are
   * indistinguishable from a cold-loaded record and a brand-new workspace's
   * agent would sit inert instead of starting.
   */
  sessionMintedThisAppSession: boolean
  /**
   * `hasAgentLaunchFailedThisAppSession(workspaceId, agentId)` — THIS app
   * session already saw this agent's launch fail (`markAgentLaunchFailed`).
   *
   * The failure branch clears `cliSessionId` and demotes `cliStartRequested`,
   * but it does NOT reset the `cliRestartNonce` (or persisted `cliStartupPrompt`)
   * that a click left behind, so `hasLaunchIntent` still reads true — and the
   * cleared session id re-enters the mint branch, which re-mints a fresh id every
   * cycle. Either signal alone flips the decision back to `spawn`, the spawn
   * fails again, and the tab spins spawn→fail→mint→spawn, notifying each time.
   *
   * When set, this gates BOTH of those spawn triggers so the tab sits inert until
   * a deliberate start clears the marker. Every deliberate (re)start path clears
   * it first (`startInertAgent`, the AgentPanel Spawn/Restart button) and a
   * successful spawn clears it, so a genuine retry always spawns; only the stale
   * intent from the just-failed attempt is suppressed.
   */
  launchFailedThisAppSession: boolean
}

/**
 * Order is the contract:
 *
 * 1. attached → `spawn`: an attached session reattaches, exactly as before.
 * 2. suspended → `paused`: freeze-the-view. Unchanged behavior, and it stays
 *    ahead of intent so an idle-reaped agent still repaints instead of
 *    respawning (what `pauseInsteadOfLaunch` did).
 * 3. alive → `spawn`: reattach the running pty.
 * 4. launch failed here → `inert`: a launch that already failed this session
 *    must not be re-triggered by the stale intent it left behind or by a
 *    re-minted id — sit inert until a deliberate start clears the marker.
 *    Ordered AFTER the live-state checks (attached/suspended/alive) so a
 *    genuinely running or paintable session still wins, and BEFORE intent/minted
 *    so it gates exactly the two spawn triggers that would otherwise loop.
 * 5. intent → `spawn`: a new agent, or one the user just started/restarted.
 * 6. minted here → `spawn`: a brand-new agent whose id this app session just
 *    created. It looks exactly like a cold-loaded record otherwise.
 * 7. otherwise → `inert`: a persisted record, no pty, no painted screen, nobody
 *    asked for it. Previously this fell through to a fresh CLI launch.
 */
export function resolveAgentColdLoadDecision(input: AgentColdLoadInput): AgentColdLoadDecision {
  if (input.attachedSessionId) return 'spawn'
  if (input.suspended) return 'paused'
  if (input.processAlive) return 'spawn'
  if (input.launchFailedThisAppSession) return 'inert'
  if (input.hasLaunchIntent) return 'spawn'
  if (input.sessionMintedThisAppSession) return 'spawn'
  return 'inert'
}

// Session ids minted during THIS renderer session. A cold-loaded agent's id came
// off disk and is absent here; a brand-new agent's id was minted by the mounting
// terminal and is present. That is the whole difference between them — both carry
// no launch flags, no live pty, and no snapshot sidecar.
//
// Renderer-session scoped on purpose: a reload IS a cold load, and the set going
// empty is the correct answer, not lost state.
const mintedSessionIds = new Set<string>()

export function markAgentSessionMinted(sessionId: string): void {
  mintedSessionIds.add(sessionId)
}

export function wasAgentSessionMintedThisAppSession(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId && mintedSessionIds.has(sessionId))
}

export function resetMintedAgentSessionsForTest(): void {
  mintedSessionIds.clear()
}

// Agents whose launch FAILED during THIS renderer session (e.g. a missing API
// key, a spawn error). Renderer-session scoped, exactly like the mint registry.
//
// This exists to break a spin loop: on a spawn failure the mounting terminal
// clears the agent's `cliSessionId`, which drops it back through the mint branch;
// the mint branch mints a fresh id and marks it minted; `resolveAgentColdLoadDecision`
// then reads that minted id as `spawn` (rule 5) even though nobody asked for it —
// and the whole thing repeats every effect cycle, spawning + notifying many times
// a second. Marking the agent as failed lets the mint branch decline to re-mark a
// replacement id, so the next decision falls through to `inert` and the tab sits
// idle until a deliberate start (which clears the marker) instead of respawning.
const failedLaunchAgents = new Set<string>()

function failedLaunchKey(workspaceId: string, agentId: string): string {
  return `${workspaceId}::${agentId}`
}

export function markAgentLaunchFailed(workspaceId: string, agentId: string): void {
  failedLaunchAgents.add(failedLaunchKey(workspaceId, agentId))
}

export function clearAgentLaunchFailed(workspaceId: string, agentId: string): void {
  failedLaunchAgents.delete(failedLaunchKey(workspaceId, agentId))
}

export function hasAgentLaunchFailedThisAppSession(workspaceId: string, agentId: string): boolean {
  return failedLaunchAgents.has(failedLaunchKey(workspaceId, agentId))
}

export function resetFailedLaunchAgentsForTest(): void {
  failedLaunchAgents.clear()
}
