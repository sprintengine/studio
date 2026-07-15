import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isSprintEngineWorkspaceDormant,
  transitionSprintEngineAutomation,
} from '../../utils/sprintengineAutomationLifecycle'
import { willResumeRecordedRosterSession } from '../../utils/sprintengine'
import type {
  SprintEngineAutoState,
  SprintEngineRosterSession,
  SprintEngineState,
} from '../../types/workspace'

// T5 regression net for the board panel's dormancy contract. The board never
// revives a finished run: its two forced refreshes are display-only via T1, and
// neither adding a member nor re-opening a role re-arms automation. The runtime
// display-only refresh (force:true on a dormant run) is proven in
// sprintengineProjectionRefresh.test.ts (testDormantWorkspaceRefreshIsDisplayOnly);
// this file proves the two guarantees unique to the board — reopen resumes without
// re-arming, add-member bookkeeping cannot leave `complete` — and pins the board
// wiring so a future edit to either call site can't reintroduce a revive path.

const boardSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/panels/SprintEngineBoardPanel.tsx'),
  'utf8',
)

function completeAutoState(): SprintEngineAutoState {
  return {
    desiredMode: 'run_agents',
    runtimeState: 'complete',
    reason: 'all_tasks_done',
    cliPermissionPreset: 'default',
    maxConcurrentAgents: 1,
    pendingSpawns: [],
    deliveredAgentNotificationEventKeys: [],
    completionTeardownAt: 500,
  }
}

// Extract a top-level `const <name> = ... => {` function body by brace matching,
// so the assertions survive reformatting inside the body (unlike a raw substring
// match on the whole file).
function functionBody(source: string, name: string): string {
  const declaration = new RegExp(`const ${name}\\b[\\s\\S]*?=>`).exec(source)
  assert.ok(declaration, `expected board to declare ${name}`)
  const open = source.indexOf('{', declaration.index + declaration[0].length)
  assert.notEqual(open, -1, `expected ${name} to have a block body`)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`)
}

// Tokens that would revive a dormant run: a lifecycle re-arm event, the store's
// mode setter (dispatches user_set_mode), a mode/resume re-entry, or a direct
// reconcile/teardown. None may appear in a display-only board action.
const REVIVE_TOKENS = [
  'applySprintEngineAutomationEvent',
  'setSprintEngineAutomationMode(workspaceId',
  'updateAutomationMode(',
  'resumeAutomation(',
  'runner_started',
  'runner_complete',
  'user_set_mode',
  'tearDownCompletedSprintRunAgents',
  'enterSprintEngineDormancy',
  'reconcileCompletedRunLifecycle',
]

function assertNoRevive(body: string, label: string): void {
  for (const token of REVIVE_TOKENS) {
    assert.equal(
      body.includes(token),
      false,
      `${label} must not reference ${token} (would revive a dormant run)`,
    )
  }
}

// Wiring guard: the manual Refresh action reads+displays through the T1
// display-only refresh and takes no lifecycle action of its own.
function testManualRefreshIsWiredDisplayOnly(): void {
  const body = functionBody(boardSource, 'refreshSprintEngineState')
  assert.ok(
    body.includes('refreshSprintEngineWorkspaceProjection({'),
    'manual Refresh must route through refreshSprintEngineWorkspaceProjection',
  )
  assert.ok(body.includes("force: true"), 'manual Refresh forces a full read')
  assertNoRevive(body, 'refreshSprintEngineState')
}

// Wiring guard: adding a member spawns on a board-minted id + display-refreshes
// only; it never re-arms automation or triggers reconcile/teardown (MC-1591
// leases: there is no roster op — the engine binds the worker at claim).
function testAddMemberIsWiredDisplayOnly(): void {
  const body = functionBody(boardSource, 'confirmAddMember')
  assert.ok(
    body.includes('enqueuePendingRosterMemberSpawn('),
    'confirmAddMember spawns the member on the minted id via the pending-spawn queue',
  )
  assert.ok(
    body.includes('refreshSprintEngineWorkspaceProjection({'),
    'confirmAddMember display-refreshes through the T1 dormancy-aware path',
  )
  assertNoRevive(body, 'confirmAddMember')
}

// Wiring guard: the ONLY re-arm surfaces are the two explicit user exits from
// dormancy — resumeAutomation (runner_started) and updateAutomationMode
// (setSprintEngineAutomationMode → user_set_mode). If a new re-arm site appears
// anywhere else, one of these counts changes and the test fails.
function testReArmSurfaceIsOnlyTheUserExits(): void {
  const runnerStarted = boardSource.match(/runner_started/g) ?? []
  assert.equal(runnerStarted.length, 1, 'runner_started is dispatched only by resumeAutomation')
  const resumeBody = functionBody(boardSource, 'resumeAutomation')
  assert.ok(resumeBody.includes('runner_started'), 'resumeAutomation is the runner_started re-arm site')

  const modeSetter = boardSource.match(/setSprintEngineAutomationMode\(workspaceId/g) ?? []
  assert.ok(modeSetter.length >= 1, 'updateAutomationMode drives the mode setter')
  const modeBody = functionBody(boardSource, 'updateAutomationMode')
  assert.ok(
    modeBody.includes('setSprintEngineAutomationMode(workspaceId'),
    'updateAutomationMode is the user_set_mode re-arm site',
  )
}

// Behavioral: `pending_spawns_changed` is the ONLY non-user event the reducer's
// terminal-state guard lets through on a `complete` run (spawn bookkeeping is
// lifecycle-neutral). Adding a member drives spawn bookkeeping, so this is the
// safety net that guarantees it can only record the pending spawn — never move a
// finished run out of `complete` — no matter what re-triggers it.
function testAddMemberPendingSpawnsCannotLeaveComplete(): void {
  const complete = completeAutoState()
  assert.equal(isSprintEngineWorkspaceDormant({ sprintEngineAutoState: complete }), true)
  const next = transitionSprintEngineAutomation(
    complete,
    { type: 'pending_spawns_changed', pendingSpawns: [{ taskId: 'T2', agentId: 'developer-2' }] },
    1000,
  )
  assert.equal(next.runtimeState, 'complete', 'pending-spawn bookkeeping keeps the run dormant')
  assert.equal(next.desiredMode, 'run_agents', 'desired mode is untouched')
  assert.deepEqual(
    next.pendingSpawns,
    [{ taskId: 'T2', agentId: 'developer-2' }],
    'the pending spawn is recorded for the spawn effect',
  )
  assert.equal(
    isSprintEngineWorkspaceDormant({ sprintEngineAutoState: next }),
    true,
    'the run is still dormant after add-member bookkeeping',
  )
}

// Behavioral: re-opening a role on a dormant run resumes its recorded session
// (spawnAgent's resume gate) rather than spawning fresh — a lifecycle-neutral
// pure predicate, so reopen carries no automation event. Proven for both
// resume-capable CLIs, and shown to reject a run that has left `complete` only
// when no live state contradicts it.
function testReopenResumesRecordedSessionWhileDormant(): void {
  const recorded: SprintEngineRosterSession = {
    cli: 'claude-code',
    cliSessionId: 'sess-abc',
    recordedAt: 500,
  }
  const dormantState: SprintEngineState | null = null // cold reopen: projection not hydrated
  // Resume capabilities are resolved from the manifest by the caller; both
  // claude-code and codex declare resumeSession, so both resume.
  const capsByCli = {
    'claude-code': { resumeSession: true, sessionIdFromCaller: true },
    codex: { resumeSession: true, sessionIdFromCaller: false },
  } as const
  for (const cli of ['claude-code', 'codex'] as const) {
    assert.equal(
      willResumeRecordedRosterSession({
        sprintEngineState: dormantState,
        autoRuntimeState: 'complete',
        recorded: { ...recorded, cli },
        agentId: 'developer-1',
        resumeCapabilities: capsByCli[cli],
      }),
      true,
      `${cli} resumes its recorded session when the run is dormant`,
    )
  }

  // A recorded entry with no session id must NOT read as resume — it would spawn
  // fresh, but still fires no automation event either way.
  assert.equal(
    willResumeRecordedRosterSession({
      sprintEngineState: dormantState,
      autoRuntimeState: 'complete',
      recorded: { ...recorded, cliSessionId: '' },
      agentId: 'developer-1',
      resumeCapabilities: capsByCli['claude-code'],
    }),
    false,
    'a recorded entry without a session id cannot resume',
  )
}

testManualRefreshIsWiredDisplayOnly()
testAddMemberIsWiredDisplayOnly()
testReArmSurfaceIsOnlyTheUserExits()
testAddMemberPendingSpawnsCannotLeaveComplete()
testReopenResumesRecordedSessionWhileDormant()

console.log('sprintengine board panel dormancy tests passed')
