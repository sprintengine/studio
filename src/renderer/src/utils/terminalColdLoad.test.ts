import assert from 'node:assert/strict'

import {
  clearAgentLaunchFailed,
  hasAgentLaunchFailedThisAppSession,
  hasLiveAgentLaunchIntent,
  markAgentLaunchFailed,
  markAgentSessionMinted,
  resetFailedLaunchAgentsForTest,
  resetMintedAgentSessionsForTest,
  resolveAgentColdLoadDecision,
  wasAgentSessionMintedThisAppSession,
  type AgentColdLoadInput,
} from './terminalColdLoad'

// A persisted agent restored from disk: identity intact, gate cleared, no pty, no
// painted screen, and its id was NOT minted in this renderer session.
const coldLoaded: AgentColdLoadInput = {
  attachedSessionId: null,
  processAlive: false,
  suspended: false,
  hasLaunchIntent: false,
  sessionMintedThisAppSession: false,
  launchFailedThisAppSession: false,
}

// --- launch intent: the predicate that separates a NEW agent from a cold-loaded
// record. Both have no session id and no sidecar, so absence of a snapshot can
// never be the signal.

assert.equal(hasLiveAgentLaunchIntent(undefined), false, 'no agent has no intent')
assert.equal(hasLiveAgentLaunchIntent({}), false, 'a bare persisted record has no intent')
assert.equal(
  hasLiveAgentLaunchIntent({ cliStartRequested: true }),
  true,
  'the create/start path sets cliStartRequested',
)
assert.equal(
  hasLiveAgentLaunchIntent({ cliRestartNonce: 1 }),
  true,
  'an explicit restart bumps the nonce',
)
assert.equal(
  hasLiveAgentLaunchIntent({ cliResumeRequested: true }),
  true,
  'a board re-open asks to reattach a recorded conversation',
)
assert.equal(
  hasLiveAgentLaunchIntent({ cliStartupPrompt: 'Work the auth revamp…' }),
  true,
  'an undelivered startup directive is live intent',
)
// The exact shape the persist normalizers leave behind: identity kept, gate
// cleared. This MUST read as no-intent or the whole fix is inert.
assert.equal(
  hasLiveAgentLaunchIntent({
    cliStartRequested: false,
    cliHasLaunched: false,
    cliResumeAvailable: false,
    cliResumeRequested: false,
    cliRestartNonce: 0,
    cliStartupPrompt: undefined,
  } as Parameters<typeof hasLiveAgentLaunchIntent>[0]),
  false,
  'a partialized cold-loaded agent carries no launch intent',
)
// cliHasLaunched is HISTORY, not intent. If it counted, every finished agent
// would spawn on cold load — the original bug, restated.
assert.equal(
  hasLiveAgentLaunchIntent({ cliHasLaunched: true } as Parameters<typeof hasLiveAgentLaunchIntent>[0]),
  false,
  'cliHasLaunched is history, never launch intent',
)

// --- the decision

assert.equal(
  resolveAgentColdLoadDecision(coldLoaded),
  'inert',
  'cold-loaded persisted agent, no pty, no sidecar → inert (previously: fresh CLI spawn)',
)
assert.equal(
  resolveAgentColdLoadDecision({ ...coldLoaded, suspended: true }),
  'paused',
  'cold-loaded agent whose session resolves a sidecar → paint and pause',
)
assert.equal(
  resolveAgentColdLoadDecision({ ...coldLoaded, hasLaunchIntent: true }),
  'spawn',
  'a newly created agent has intent and no sidecar → it must still spawn',
)
assert.equal(
  resolveAgentColdLoadDecision({ ...coldLoaded, processAlive: true }),
  'spawn',
  'a live pty reattaches',
)
assert.equal(
  resolveAgentColdLoadDecision({ ...coldLoaded, attachedSessionId: 'sess-attached' }),
  'spawn',
  'an attached session always reattaches',
)

// Ordering is the contract, so pin the overlaps.
assert.equal(
  resolveAgentColdLoadDecision({ ...coldLoaded, suspended: true, hasLaunchIntent: true }),
  'paused',
  'suspended outranks intent: an idle-reaped agent repaints rather than respawning (freeze-the-view)',
)
assert.equal(
  resolveAgentColdLoadDecision({ ...coldLoaded, suspended: true, attachedSessionId: 'sess-attached' }),
  'spawn',
  'attached outranks suspended, exactly as pauseInsteadOfLaunch required !attachedSessionId',
)

// A dead-cwd cold-loaded agent (finished automation whose worktree was finalized
// away) is inert on the SAME inputs — the decision does not consult the cwd at
// all, which is what keeps it ahead of resolveWorktreeSpawnFallback in
// TerminalView. Nothing to spawn means nothing to redirect.
assert.equal(
  resolveAgentColdLoadDecision(coldLoaded),
  'inert',
  'dead-cwd cold-loaded agent lands inert, never redirected into the main checkout and spawned',
)

// --- the mint registry: the OTHER way a brand-new agent proves it is new.
//
// A workspace template seeds agents via defaultAgent — no session id, no
// cliStartRequested, no prompt. On mount the terminal mints an id for them. By
// the time the decision runs they are byte-identical to a cold-loaded record, so
// without this signal a brand-new workspace's agents would sit inert instead of
// starting. That is a worse regression than the bug being fixed.

resetMintedAgentSessionsForTest()

const templateAgent = { ...coldLoaded }
assert.equal(
  resolveAgentColdLoadDecision(templateAgent),
  'inert',
  'sanity: with no mint record and no intent, it is a cold-loaded record',
)

assert.equal(wasAgentSessionMintedThisAppSession('sess-new'), false, 'unknown id was not minted here')
assert.equal(wasAgentSessionMintedThisAppSession(undefined), false, 'no id was not minted here')
markAgentSessionMinted('sess-new')
assert.equal(wasAgentSessionMintedThisAppSession('sess-new'), true, 'the mounting terminal minted this id')

assert.equal(
  resolveAgentColdLoadDecision({ ...coldLoaded, sessionMintedThisAppSession: true }),
  'spawn',
  'a template agent whose id THIS session minted still spawns — it is new, not restored',
)

// The id of a cold-loaded agent came off disk, so it is absent from the registry
// even though the agent has a session id. This is the whole distinction.
assert.equal(
  wasAgentSessionMintedThisAppSession('sess-restored-from-disk'),
  false,
  'a persisted id is not in the mint registry — restored, not minted',
)

// A reload IS a cold load: the registry going empty is the correct answer.
resetMintedAgentSessionsForTest()
assert.equal(
  wasAgentSessionMintedThisAppSession('sess-new'),
  false,
  'the mint registry is renderer-session scoped; after a reload nothing counts as minted',
)

// --- launchFailedThisAppSession gating the decision (backlog 1716).
//
// The failed-launch marker used to gate only the mint branch. But a click on an
// inert failed agent (startInertAgent) bumps cliRestartNonce, and the failure
// branch that re-clears cliSessionId does NOT reset that nonce — so the record
// still carries live intent AND re-enters the mint branch. Gating only the mint
// left hasLaunchIntent (rule 5) firing 'spawn' every cycle: spawn→fail→mint→
// spawn, a notify each loop. The decision must fall to inert when the marker is
// set, regardless of the stale intent or a re-minted id.
assert.equal(
  resolveAgentColdLoadDecision({ ...coldLoaded, launchFailedThisAppSession: true, hasLaunchIntent: true }),
  'inert',
  'a launch that failed this session must NOT respawn on the stale intent it left behind (click-retry-fails loop)',
)
assert.equal(
  resolveAgentColdLoadDecision({ ...coldLoaded, launchFailedThisAppSession: true, sessionMintedThisAppSession: true }),
  'inert',
  'a re-minted id after a failed launch does not force a respawn while the marker is set',
)
// A deliberate retry clears the marker first (startInertAgent / the AgentPanel
// Spawn button), so with the marker cleared the fresh intent spawns as normal —
// the gate suppresses only the stale attempt, never a genuine retry.
assert.equal(
  resolveAgentColdLoadDecision({ ...coldLoaded, launchFailedThisAppSession: false, hasLaunchIntent: true }),
  'spawn',
  'clearing the marker on a deliberate retry lets the fresh intent spawn',
)
// Live-state checks still outrank the failed marker: a real pty, a paintable
// suspended screen, or an attached session is not overridden by a stale failure.
assert.equal(
  resolveAgentColdLoadDecision({ ...coldLoaded, launchFailedThisAppSession: true, processAlive: true }),
  'spawn',
  'a live pty reattaches even if an earlier launch failed this session',
)
assert.equal(
  resolveAgentColdLoadDecision({ ...coldLoaded, launchFailedThisAppSession: true, suspended: true }),
  'paused',
  'a paintable suspended screen still repaints even if an earlier launch failed',
)
assert.equal(
  resolveAgentColdLoadDecision({ ...coldLoaded, launchFailedThisAppSession: true, attachedSessionId: 'sess-attached' }),
  'spawn',
  'an attached session reattaches even if an earlier launch failed this session',
)

// --- the failed-launch registry: the guard that stops a failed spawn from
// respawning + re-notifying every effect cycle.
//
// A spawn failure (missing API key, spawn error) clears the agent's cliSessionId,
// which re-enters the mint branch. Without this marker the mint branch marks the
// replacement id, the decision reads `spawn` again, and the failure loops. The
// marker is per (workspace, agent), renderer-session scoped like the mint set.

resetFailedLaunchAgentsForTest()

assert.equal(
  hasAgentLaunchFailedThisAppSession('ws-1', 'agent-kimi'),
  false,
  'a fresh agent has no failure on record',
)

markAgentLaunchFailed('ws-1', 'agent-kimi')
assert.equal(
  hasAgentLaunchFailedThisAppSession('ws-1', 'agent-kimi'),
  true,
  'a failed launch is recorded for that workspace+agent',
)

// The marker is scoped to the exact (workspace, agent) pair — a different agent,
// or the same agent id in another workspace, is unaffected.
assert.equal(
  hasAgentLaunchFailedThisAppSession('ws-1', 'agent-claude'),
  false,
  'a sibling agent in the same workspace is not marked',
)
assert.equal(
  hasAgentLaunchFailedThisAppSession('ws-2', 'agent-kimi'),
  false,
  'the same agent id in another workspace is not marked',
)

// A deliberate start (click/type) clears the marker so the retry re-mints and is
// allowed to spawn.
clearAgentLaunchFailed('ws-1', 'agent-kimi')
assert.equal(
  hasAgentLaunchFailedThisAppSession('ws-1', 'agent-kimi'),
  false,
  'clearing the marker lets the next launch attempt proceed',
)

// A reload is a cold load: the registry going empty is correct, matching the mint
// set's renderer-session scoping.
markAgentLaunchFailed('ws-1', 'agent-kimi')
resetFailedLaunchAgentsForTest()
assert.equal(
  hasAgentLaunchFailedThisAppSession('ws-1', 'agent-kimi'),
  false,
  'the failed-launch registry is renderer-session scoped; a reload clears it',
)

console.log('terminalColdLoad tests passed')
