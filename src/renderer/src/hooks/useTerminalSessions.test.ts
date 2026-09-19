import assert from 'node:assert/strict'
import type { TerminalSessionSnapshot } from '../../../shared/electron-api'
import { formatRelativeMs, formatRelativeMsAgo } from '../utils/relativeTime'
import {
  deriveWorkspaceDisplayActivity,
  deriveWorkspaceIdleSince,
  deriveWorkspaceLastInputAt,
  deriveWorkspaceTerminalActivity,
  deriveWorkspaceWorkingSince,
  findLiveSession,
  getTerminalSessionsSignature,
  isLiveTerminal,
  isSessionWorking,
  pickAgentTabRecency,
  pickTerminalTabRecency,
  tabRecencyLabel,
  workspaceTerminalAwaitingInput,
} from './useTerminalSessions'
import { createTerminalSessionsStore } from './terminalSessionsStore'
import { test } from 'vitest'

test('useTerminalSessions', async () => {
  const suiteRun = main()

  async function main(): Promise<void> {
    assertProcessAliveHelpersUseLivenessOnly()
    assertShortRecencyStartsAtOneMinute()
    assertSignatureIgnoresOutputTimingButTracksActivity()
    assertWorkspaceDisplayActivityPriority()
    assertAwaitingInputHookSurfacesAsNeedsInput()
    assertWorkspaceTerminalActivityPriorityAndPersistedRecency()
    assertIdleSinceIsWhenTheAgentFinished()
    assertWorkingSinceOnlyCountsAHookReportedTurn()
    assertSuspendedSessionNeverReadsAsWorking()
    assertTerminalTabRecencyUsesIdleTransition()
    assertAgentTabRecencyFallbackChain()
    await assertSharedStoreUsesOneUnderlyingSubscription()
    await assertSharedStoreDedupsSemanticUpdatesButKeepsLive()
    await assertSharedStoreHandlesDuplicateSubscriberCallbacks()
    await assertSharedStoreIgnoresDisconnectedInitialRefresh()
    await assertStaleLaunchFlagsClearWithoutLosingRecency()
    await assertClaudeSessionIdentitySurvivesStartupReconciliation()
    await assertClaudeCodeSessionIdentitySurvivesStartupReconciliation()
  }

  function assertShortRecencyStartsAtOneMinute(): void {
    const now = 120_000
    assert.equal(formatRelativeMs(now, now), '')
    assert.equal(formatRelativeMs(now - 59_999, now), '')
    assert.equal(formatRelativeMs(now - 60_000, now), '1m')
    assert.equal(formatRelativeMs(now - 119_999, now), '1m')
    assert.equal(formatRelativeMsAgo(now - 59_999, now), 'just now')
    assert.equal(formatRelativeMsAgo(now - 60_000, now), '1m ago')
  }

  // The hook dedupes broadcasts by this signature: a snapshot that only bumps
  // lastOutputAt must be considered unchanged (no re-render), while an activity or
  // lifecycle change must produce a different signature (re-render).
  function assertSignatureIgnoresOutputTimingButTracksActivity(): void {
    const base = [
      session({ sessionId: 'a', activity: { kind: 'working', since: 1 }, lastOutputAt: 100 }),
      session({ sessionId: 'b', activity: { kind: 'idle', since: 2 }, lastOutputAt: 200 }),
    ]
    // Same sessions, only lastOutputAt advanced -> identical signature.
    const outputOnly = [
      session({ sessionId: 'a', activity: { kind: 'working', since: 1 }, lastOutputAt: 999 }),
      session({ sessionId: 'b', activity: { kind: 'idle', since: 2 }, lastOutputAt: 888 }),
    ]
    assert.equal(getTerminalSessionsSignature(base), getTerminalSessionsSignature(outputOnly))

    // Order-independent: the signature sorts by sessionId first.
    assert.equal(getTerminalSessionsSignature(base), getTerminalSessionsSignature([base[1], base[0]]))

    // An observed checkout must survive the dedupe — the tab glyph and
    // identity card render it: both the cwd moving and git's later answer for it.
    const observedMoved = [
      session({
        sessionId: 'a',
        activity: { kind: 'working', since: 1 },
        lastOutputAt: 100,
        observedCheckout: {
          cwd: '/wt',
          at: 5,
          resolved: false,
          gitRoot: null,
          repoRoot: null,
          branch: null,
          isLinkedWorktree: false,
        },
      }),
      base[1],
    ]
    assert.notEqual(
      getTerminalSessionsSignature(base),
      getTerminalSessionsSignature(observedMoved),
      'a cwd move re-renders',
    )
    const observedResolved = [
      session({
        sessionId: 'a',
        activity: { kind: 'working', since: 1 },
        lastOutputAt: 100,
        observedCheckout: {
          cwd: '/wt',
          at: 5,
          resolved: true,
          gitRoot: '/wt',
          repoRoot: '/repo',
          branch: 'agent/x',
          isLinkedWorktree: true,
        },
      }),
      base[1],
    ]
    assert.notEqual(
      getTerminalSessionsSignature(observedMoved),
      getTerminalSessionsSignature(observedResolved),
      'git answering re-renders',
    )

    // An activity-kind transition changes the signature.
    const activityChanged = [
      session({ sessionId: 'a', activity: { kind: 'idle', since: 1 }, lastOutputAt: 100 }),
      session({ sessionId: 'b', activity: { kind: 'idle', since: 2 }, lastOutputAt: 200 }),
    ]
    assert.notEqual(getTerminalSessionsSignature(base), getTerminalSessionsSignature(activityChanged))

    // Same activity kind but different activity payload still matters to normal UI
    // that renders failed/working timing and details.
    const activityDetailChanged = [
      session({ sessionId: 'a', activity: { kind: 'working', since: 9 }, lastOutputAt: 100 }),
      session({ sessionId: 'b', activity: { kind: 'idle', since: 2 }, lastOutputAt: 200 }),
    ]
    assert.notEqual(getTerminalSessionsSignature(base), getTerminalSessionsSignature(activityDetailChanged))

    // A lifecycle change (process death) changes the signature.
    const exited = [
      session({ sessionId: 'a', processAlive: false, activity: { kind: 'working', since: 1 } }),
      session({ sessionId: 'b', activity: { kind: 'idle', since: 2 } }),
    ]
    assert.notEqual(getTerminalSessionsSignature(base), getTerminalSessionsSignature(exited))

    // Execution identity is how a module's panels connect a running task to
    // its terminal.
    const executionChanged = [
      session({
        sessionId: 'a',
        activity: { kind: 'working', since: 1 },
        lastOutputAt: 100,
        agentSession: {
          ...base[0].agentSession!,
          executionId: 'exec_2',
        },
      }),
      session({ sessionId: 'b', activity: { kind: 'idle', since: 2 }, lastOutputAt: 200 }),
    ]
    assert.notEqual(getTerminalSessionsSignature(base), getTerminalSessionsSignature(executionChanged))

    // The per-session file ledger and the subagent count move with no phase and
    // no activity change behind them, so the signature has to carry them or the
    // numbers a row shows would never repaint. Each pair below moves exactly ONE
    // component, so each pins its own.
    const ledger = (
      changes: Array<{ path: string; additions: number; deletions: number; edits: number; lastEditedAt: number }>,
    ) => [
      session({ sessionId: 'a', activity: { kind: 'working', since: 1 }, lastOutputAt: 100, fileChanges: changes }),
      base[1],
    ]
    const oneFile = [{ path: '/repo/a.ts', additions: 4, deletions: 1, edits: 1, lastEditedAt: 50 }]
    assert.notEqual(
      getTerminalSessionsSignature(base),
      getTerminalSessionsSignature(ledger(oneFile)),
      'a first edit re-renders',
    )
    assert.equal(
      getTerminalSessionsSignature(ledger(oneFile)),
      getTerminalSessionsSignature(ledger([{ ...oneFile[0] }])),
      'an equal ledger delivered as a fresh array is not a change: the dedupe is by value, not identity',
    )
    assert.notEqual(
      getTerminalSessionsSignature(ledger(oneFile)),
      getTerminalSessionsSignature(ledger([{ ...oneFile[0], additions: 5 }])),
      'added lines alone re-render',
    )
    assert.notEqual(
      getTerminalSessionsSignature(ledger(oneFile)),
      getTerminalSessionsSignature(ledger([{ ...oneFile[0], deletions: 2 }])),
      'removed lines alone re-render',
    )
    assert.notEqual(
      getTerminalSessionsSignature(ledger(oneFile)),
      getTerminalSessionsSignature(ledger([{ ...oneFile[0], edits: 2 }])),
      'an edit that changed no line count at all — the reporter’s answer for a tool it cannot count — still re-renders',
    )
    assert.notEqual(
      getTerminalSessionsSignature(ledger(oneFile)),
      getTerminalSessionsSignature(ledger([{ ...oneFile[0], lastEditedAt: 70 }])),
      'a newer edit time alone re-renders',
    )
    const twoFiles = [{ path: '/repo/b.ts', additions: 0, deletions: 0, edits: 1, lastEditedAt: 50 }, oneFile[0]]
    assert.notEqual(
      getTerminalSessionsSignature(ledger(oneFile)),
      getTerminalSessionsSignature(ledger(twoFiles)),
      'a second file re-renders even when it changed no lines',
    )
    assert.notEqual(
      getTerminalSessionsSignature(ledger(twoFiles)),
      getTerminalSessionsSignature(ledger([twoFiles[1], twoFiles[0]])),
      'the list is rendered newest-first, so promoting a file to the head re-renders',
    )
    // Same head file, same totals, same edit count, same time — two edits of one
    // file against one edit each of two. Only the file COUNT tells them apart,
    // and a row that says "2 files" has to notice.
    assert.notEqual(
      getTerminalSessionsSignature(
        ledger([{ path: '/repo/a.ts', additions: 4, deletions: 0, edits: 2, lastEditedAt: 50 }]),
      ),
      getTerminalSessionsSignature(
        ledger([
          { path: '/repo/a.ts', additions: 2, deletions: 0, edits: 1, lastEditedAt: 50 },
          { path: '/repo/b.ts', additions: 2, deletions: 0, edits: 1, lastEditedAt: 50 },
        ]),
      ),
      'the same work spread over two files is a different ledger',
    )
    const withContext = (contextUsage: { usedPercentage: number; at: number } | null) => [
      session({ sessionId: 'a', activity: { kind: 'working', since: 1 }, lastOutputAt: 100, contextUsage }),
      base[1],
    ]
    assert.notEqual(
      getTerminalSessionsSignature(base),
      getTerminalSessionsSignature(withContext({ usedPercentage: 8, at: 50 })),
      'a first context reading re-renders',
    )
    // `at` held CONSTANT: every other assertion here would pass with the
    // percentage left out of the signature entirely, because a moving `at` moves
    // the row on its own. This one fails without the field the signature exists
    // to carry.
    assert.notEqual(
      getTerminalSessionsSignature(withContext({ usedPercentage: 8, at: 50 })),
      getTerminalSessionsSignature(withContext({ usedPercentage: 9, at: 50 })),
      'a moved percentage re-renders',
    )
    // And the converse: `at` is deliberately NOT in the signature, so a reading
    // re-stamped at the same percentage is not a repaint.
    assert.equal(
      getTerminalSessionsSignature(withContext({ usedPercentage: 8, at: 50 })),
      getTerminalSessionsSignature(withContext({ usedPercentage: 8, at: 900 })),
      'a re-stamped identical percentage is not news',
    )
    assert.equal(
      getTerminalSessionsSignature(withContext({ usedPercentage: 8, at: 50 })),
      getTerminalSessionsSignature(withContext({ usedPercentage: 8, at: 50 })),
      'and an unchanged one does not',
    )
    // Zero is a reading — a session that has just been compacted to nothing is
    // not a session nothing has read.
    assert.notEqual(
      getTerminalSessionsSignature(withContext(null)),
      getTerminalSessionsSignature(withContext({ usedPercentage: 0, at: 0 })),
      'zero percent is a reading, not an absence',
    )
    // The pull request marks, for the same reason as the context reading above: a
    // pull request lands on GitHub, or a branch lookup finally answers, and no
    // other field on the snapshot moves. Without this term the sidebar's mark and
    // the peek's head — both on the SEMANTIC channel — never heard about it.
    const withPullRequests = (pullRequests: TerminalSessionSnapshot['pullRequests']) => [
      session({ sessionId: 'a', activity: { kind: 'working', since: 1 }, lastOutputAt: 100, pullRequests }),
      base[1],
    ]
    const mark = (
      over: Partial<NonNullable<TerminalSessionSnapshot['pullRequests']>[number]> & { number: number },
    ): NonNullable<TerminalSessionSnapshot['pullRequests']>[number] => ({
      url: `https://github.com/acme/sprintengine/pull/${over.number}`,
      repoKey: 'github.com/acme/sprintengine',
      repoName: 'sprintengine',
      number: over.number,
      title: over.title ?? '',
      state: over.state ?? 'open',
      isDraft: over.isDraft ?? false,
      openedAt: over.openedAt ?? 10,
      stateAt: over.stateAt ?? 20,
    })
    assert.notEqual(
      getTerminalSessionsSignature(base),
      getTerminalSessionsSignature(withPullRequests([mark({ number: 418 })])),
      'a first pull request re-renders — the mark has to appear',
    )
    assert.notEqual(
      getTerminalSessionsSignature(withPullRequests([mark({ number: 418 })])),
      getTerminalSessionsSignature(withPullRequests([mark({ number: 418, state: 'merged' })])),
      'a pull request landing on GitHub re-renders: the shape and the tone both change',
    )
    assert.notEqual(
      getTerminalSessionsSignature(withPullRequests([mark({ number: 418 })])),
      getTerminalSessionsSignature(withPullRequests([mark({ number: 418, isDraft: true })])),
      'a draft says so in the tooltip, so the flag is rendered',
    )
    assert.notEqual(
      getTerminalSessionsSignature(withPullRequests([mark({ number: 418 })])),
      getTerminalSessionsSignature(withPullRequests([mark({ number: 418, title: 'Gate OSC 52' })])),
      'a captured pull request learning its title re-renders: the peek leads with it',
    )
    assert.notEqual(
      getTerminalSessionsSignature(withPullRequests([mark({ number: 418 })])),
      getTerminalSessionsSignature(withPullRequests([mark({ number: 418 }), mark({ number: 421 })])),
      'a second pull request re-renders: the peek grows its chevron',
    )
    // `stateAt` held out, like `contextUsage.at`: the watch re-stamps it on every
    // backoff tick whether or not GitHub said anything new, and a repaint per
    // tick per window is exactly what this signature exists to prevent.
    assert.equal(
      getTerminalSessionsSignature(withPullRequests([mark({ number: 418, stateAt: 20 })])),
      getTerminalSessionsSignature(withPullRequests([mark({ number: 418, stateAt: 9_000 })])),
      'a re-read that changed nothing is not news',
    )
    const subagentRunning = [
      session({ sessionId: 'a', activity: { kind: 'working', since: 1 }, lastOutputAt: 100, activeSubagents: 2 }),
      base[1],
    ]
    assert.notEqual(
      getTerminalSessionsSignature(base),
      getTerminalSessionsSignature(subagentRunning),
      'a subagent count is rendered, so it must survive the dedupe',
    )
    // Several harnesses cast their way to a snapshot; a signature is not the
    // place to learn that a field is missing.
    const partial = { ...base[0] } as Partial<TerminalSessionSnapshot>
    delete partial.fileChanges
    delete partial.activeSubagents
    delete partial.contextUsage
    delete partial.pullRequests
    assert.equal(
      getTerminalSessionsSignature([partial as TerminalSessionSnapshot, base[1]]),
      getTerminalSessionsSignature(base),
      'a snapshot missing the new fields reads as an empty ledger, no subagents, no reading and no pull requests, not a crash',
    )
  }

  // The sidebar row's "working for 4m" clock. Owner report 2026-09-04: resuming a
  // suspended terminal started it with nothing asked of the agent, because every
  // session is born `working` in the lifecycle phase `starting`.
  // Owner, 2026-09-05: after a restart every parked chat read the same idle time
  // — the moment the app quit — because the reaper's suspend and the quit-path
  // sidecar restamp activity with when the process died. The hook-reported turn
  // end is the honest stamp, and it must win over exit/suspend, survive into the
  // persisted workspace record, and never outrank a genuine failure.
  function assertIdleSinceIsWhenTheAgentFinished(): void {
    const suspendedAfterFinishing = session({
      sessionId: 'suspended',
      processAlive: false,
      suspended: true,
      // Suspended (activity restamped) at 900, but the agent finished at 400.
      activity: { kind: 'exited', at: 900, exitCode: 0 },
      lastTurnEndedAt: 400,
    })
    assert.equal(deriveWorkspaceIdleSince('workspace_1', [suspendedAfterFinishing]), 400, 'the finish, not the suspend')

    const stillWorking = session({
      sessionId: 'working',
      activity: { kind: 'working', since: 1_000 },
      lastTurnEndedAt: 400,
    })
    assert.equal(
      deriveWorkspaceIdleSince('workspace_1', [stillWorking]),
      400,
      'a turn in flight keeps the last finish (the row hides it while working)',
    )

    const failed = session({
      sessionId: 'failed',
      activity: { kind: 'failed', at: 950, exitCode: 1 },
      lastTurnEndedAt: 400,
    })
    assert.equal(deriveWorkspaceIdleSince('workspace_1', [failed]), 950, 'a failure keeps its own stamp')

    // No session at all (parked, sidecar not yet rehydrated): the persisted
    // stamps stand in, whichever is later; either alone suffices.
    assert.equal(deriveWorkspaceIdleSince('workspace_1', [], 300, 700), 700)
    assert.equal(deriveWorkspaceIdleSince('workspace_1', [], 800, 700), 800)
    assert.equal(deriveWorkspaceIdleSince('workspace_1', [], null, 700), 700)
    assert.equal(deriveWorkspaceIdleSince('workspace_1', [], null, null), null)
  }

  function assertWorkingSinceOnlyCountsAHookReportedTurn(): void {
    // A session freshly resumed: born working, phase 'starting', stamped by the
    // lifecycle rather than reported by a hook. No turn, so no clock.
    const resumed = session({
      sessionId: 'resumed',
      startedAt: 5_000,
      activity: { kind: 'working', since: 5_000 },
      agentState: { phase: 'starting', since: 5_000, source: 'lifecycle' },
    })
    assert.equal(deriveWorkspaceWorkingSince('workspace_1', [resumed]), null)

    // Awaiting the person is not working either, however live the row looks.
    const awaiting = session({
      sessionId: 'awaiting',
      activity: { kind: 'working', since: 5_000 },
      agentState: { phase: 'awaiting_input', since: 6_000, source: 'hook' },
    })
    assert.equal(deriveWorkspaceWorkingSince('workspace_1', [awaiting]), null)

    // A genuine turn on a settled agent reads from the pinned activity `since`,
    // which marks the turn rather than the current thinking/tool_use step.
    const working = session({
      sessionId: 'working',
      activity: { kind: 'working', since: 9_000 },
      agentState: { phase: 'tool_use', since: 11_000, source: 'hook' },
    })
    assert.equal(deriveWorkspaceWorkingSince('workspace_1', [working]), 9_000)

    // The first real turn after a resume: `activity.since` still carries the
    // launch seed (the runtime declines to re-stamp an already-working session),
    // so the prompt the person actually submitted overtakes it.
    const promptedAfterResume = session({
      sessionId: 'prompted',
      startedAt: 5_000,
      activity: { kind: 'working', since: 5_000 },
      agentState: { phase: 'thinking', since: 30_000, source: 'hook' },
      lastPrompt: { text: 'go', at: 29_000 },
    })
    assert.equal(deriveWorkspaceWorkingSince('workspace_1', [promptedAfterResume]), 29_000)

    // A prompt left over from an earlier turn never pulls the clock backwards.
    const stalePrompt = session({
      sessionId: 'stale-prompt',
      activity: { kind: 'working', since: 40_000 },
      agentState: { phase: 'thinking', since: 40_000, source: 'hook' },
      lastPrompt: { text: 'earlier', at: 1_000 },
    })
    assert.equal(deriveWorkspaceWorkingSince('workspace_1', [stalePrompt]), 40_000)

    // Two turns in one workspace: the longest-running one holds the row.
    assert.equal(deriveWorkspaceWorkingSince('workspace_1', [stalePrompt, working]), 9_000)

    // Another workspace's turn is not this row's clock.
    assert.equal(deriveWorkspaceWorkingSince('workspace_2', [working]), null)
  }

  function assertProcessAliveHelpersUseLivenessOnly(): void {
    const exitedWorking = session({
      sessionId: 'session_exited_working',
      processAlive: false,
      activity: { kind: 'working', since: 10 },
    })
    const liveIdle = session({
      sessionId: 'session_live_idle',
      processAlive: true,
      activity: { kind: 'idle', since: 20 },
    })

    assert.equal(isLiveTerminal(exitedWorking), false)
    assert.equal(isLiveTerminal(liveIdle), true)
    assert.equal(findLiveSession([exitedWorking, liveIdle], () => true)?.sessionId, 'session_live_idle')
  }

  function assertWorkspaceDisplayActivityPriority(): void {
    const sessions = [
      session({
        sessionId: 'session_working',
        activity: { kind: 'working', since: 100 },
      }),
      session({
        sessionId: 'session_failed',
        activity: { kind: 'failed', at: 200, exitCode: 1 },
      }),
    ]

    assert.equal(deriveWorkspaceDisplayActivity('workspace_1', sessions), 'working')
    assert.equal(deriveWorkspaceDisplayActivity('workspace_1', [sessions[1]]), 'failed')
    assert.equal(
      deriveWorkspaceDisplayActivity('workspace_1', [
        session({ sessionId: 'session_idle', activity: { kind: 'idle', since: 300 } }),
      ]),
      'idle',
    )
  }

  // An agent whose lifecycle hooks report `awaiting_input` must surface as
  // `needs-input` even when its bridged activity is idle — and it must change the dedupe signature so the
  // sidebar re-renders on the phase flip.
  function assertAwaitingInputHookSurfacesAsNeedsInput(): void {
    const awaiting = session({
      sessionId: 'session_awaiting',
      activity: { kind: 'idle', since: 50 },
      agentState: { phase: 'awaiting_input', since: 60, source: 'hook' },
    })
    assert.equal(workspaceTerminalAwaitingInput('workspace_1', [awaiting]), true)
    // Wins over the idle activity, with the SprintEngine flag off.
    assert.equal(deriveWorkspaceDisplayActivity('workspace_1', [awaiting]), 'needs-input')
    // Scoped to the workspace: another workspace's awaiting agent does not leak in.
    assert.equal(workspaceTerminalAwaitingInput('workspace_2', [awaiting]), false)
    // Non-agent sessions are ignored.
    const shellAwaiting = session({
      sessionId: 'session_shell',
      kind: 'terminal',
      agentState: { phase: 'awaiting_input', since: 60, source: 'hook' },
    })
    assert.equal(workspaceTerminalAwaitingInput('workspace_1', [shellAwaiting]), false)

    // A dead agent's stale awaiting_input must not keep the glyph lit: `onExit`
    // clears agentState, but a dead session is still snapshotted, and only a live
    // agent can actually be waiting on the user.
    const deadAwaiting = session({
      sessionId: 'session_dead',
      processAlive: false,
      activity: { kind: 'exited', at: 90, exitCode: 0 },
      agentState: { phase: 'awaiting_input', since: 60, source: 'hook' },
    })
    assert.equal(workspaceTerminalAwaitingInput('workspace_1', [deadAwaiting]), false)
    assert.equal(deriveWorkspaceDisplayActivity('workspace_1', [deadAwaiting]), 'idle')

    // Entering awaiting_input changes the signature so consumers re-render even
    // though the bridged `activity` (idle) is unchanged.
    const working = session({
      sessionId: 'session_phase',
      activity: { kind: 'idle', since: 50 },
      agentState: { phase: 'tool_use', since: 55, source: 'hook' },
    })
    const flipped = session({
      sessionId: 'session_phase',
      activity: { kind: 'idle', since: 50 },
      agentState: { phase: 'awaiting_input', since: 70, source: 'hook' },
    })
    assert.notEqual(getTerminalSessionsSignature([working]), getTerminalSessionsSignature([flipped]))

    // But churn between non-attention phases must NOT change the signature — that
    // would re-render the sidebar on every tool call for no visible difference.
    const thinking = session({
      sessionId: 'session_phase',
      activity: { kind: 'idle', since: 50 },
      agentState: { phase: 'thinking', since: 80, source: 'hook' },
    })
    assert.equal(getTerminalSessionsSignature([working]), getTerminalSessionsSignature([thinking]))
  }

  function assertWorkspaceTerminalActivityPriorityAndPersistedRecency(): void {
    const failedOlder = session({
      sessionId: 'session_failed_old',
      activity: { kind: 'failed', at: 200, exitCode: 1, message: 'old failure' },
    })
    const failedNewer = session({
      sessionId: 'session_failed_new',
      activity: { kind: 'failed', at: 300, exitCode: 2, message: 'new failure' },
    })
    const idle = session({
      sessionId: 'session_idle',
      activity: { kind: 'idle', since: 400 },
      // Recency keys off lastInputAt (last typed), not lastOutputAt; the high
      // lastOutputAt must be ignored so revealing a workspace never reads as "now".
      lastInputAt: 450,
      lastOutputAt: 9_999,
    })

    assert.deepEqual(deriveWorkspaceTerminalActivity('workspace_1', [failedOlder, failedNewer, idle], 500), {
      kind: 'failed',
      at: 300,
      exitCode: 2,
      message: 'new failure',
    })
    assert.deepEqual(deriveWorkspaceTerminalActivity('workspace_1', [idle], 500), {
      kind: 'idle-recency',
      lastInputAt: 500,
    })
    assert.equal(deriveWorkspaceLastInputAt('workspace_1', [idle], 425), 450)
    assert.deepEqual(deriveWorkspaceTerminalActivity('workspace_1', [], 500), {
      kind: 'idle-recency',
      lastInputAt: 500,
    })
    assert.deepEqual(deriveWorkspaceTerminalActivity('workspace_1', [], null), { kind: 'quiet' })
    assert.equal(deriveWorkspaceIdleSince('workspace_1', [idle], 500), 400)
    assert.equal(deriveWorkspaceIdleSince('workspace_1', [], 500), 500)

    const workingTerminal = session({
      sessionId: 'plain_terminal_working',
      kind: 'terminal',
      activity: { kind: 'working', since: 600 },
    })
    assert.deepEqual(deriveWorkspaceTerminalActivity('workspace_1', [workingTerminal]), { kind: 'working', since: 600 })
  }

  // A session suspended mid-turn keeps the `working` stamp it had when its pty
  // was killed — nothing in main revisits it, and the stall watch that would have
  // expired the phase is disarmed by the suspend. Observed live 2026-09-10: an
  // agent paused one second after launch sat at `starting`/`working` for 70
  // minutes, and the sidebar drew its chat bold, with working dots and no idle
  // clock, the whole time — the row claiming an agent that was not there.
  //
  // So every "is this working" reading is gated on the process being alive, the
  // way the awaiting-input reading already was.
  function assertSuspendedSessionNeverReadsAsWorking(): void {
    const suspendedMidTurn = session({
      sessionId: 'session_suspended_mid_turn',
      processAlive: false,
      suspended: true,
      activity: { kind: 'working', since: 1_000 },
      agentState: { phase: 'thinking', since: 1_000, source: 'hook' },
      lastPrompt: { at: 1_000, text: 'go' },
    })

    assert.equal(isSessionWorking(suspendedMidTurn), false)
    assert.deepEqual(
      deriveWorkspaceTerminalActivity('workspace_1', [suspendedMidTurn], 900),
      { kind: 'idle-recency', lastInputAt: 900 },
      'a paused chat falls back to recency, not to a turn in flight',
    )
    assert.equal(
      deriveWorkspaceDisplayActivity('workspace_1', [suspendedMidTurn]),
      'idle',
      'the row that lights the sidebar and the peek card must go quiet',
    )
    assert.equal(
      deriveWorkspaceWorkingSince('workspace_1', [suspendedMidTurn]),
      null,
      'no elapsed counter for a turn whose process is gone',
    )

    // The gate is liveness alone: a live session mid-turn is untouched, and one
    // live agent still lights a workspace that also holds a frozen one.
    const liveMidTurn = session({
      sessionId: 'session_live_mid_turn',
      activity: { kind: 'working', since: 2_000 },
      agentState: { phase: 'thinking', since: 2_000, source: 'hook' },
    })
    assert.equal(isSessionWorking(liveMidTurn), true)
    assert.deepEqual(deriveWorkspaceTerminalActivity('workspace_1', [suspendedMidTurn, liveMidTurn], 900), {
      kind: 'working',
      since: 2_000,
    })
  }

  function assertTerminalTabRecencyUsesIdleTransition(): void {
    const exitedWithOlderInput = session({
      sessionId: 'session_exited_with_input',
      processAlive: false,
      activity: { kind: 'exited', at: 5_000, exitCode: 0 },
      // A high lastOutputAt must not win: recency is "last typed", from lastInputAt.
      lastInputAt: 1_000,
      lastOutputAt: 9_999,
      exitedAt: 5_000,
    })
    const exitedRecency = pickTerminalTabRecency(exitedWithOlderInput)
    assert.deepEqual(exitedRecency, { at: 1_000, source: 'input' })
    assert.equal(tabRecencyLabel(exitedRecency!.source), 'Last typed')

    const exitedWithoutInput = session({
      sessionId: 'session_exited_no_input',
      processAlive: false,
      activity: { kind: 'exited', at: 7_000, exitCode: 0 },
      lastInputAt: null,
      lastOutputAt: 6_500,
      exitedAt: 7_000,
    })
    assert.deepEqual(pickTerminalTabRecency(exitedWithoutInput), { at: 7_000, source: 'exited' })

    const liveIdleWithInput = session({
      sessionId: 'session_live_idle',
      processAlive: true,
      activity: { kind: 'idle', since: 2_500 },
      lastInputAt: 2_400,
    })
    assert.deepEqual(pickTerminalTabRecency(liveIdleWithInput), { at: 2_500, source: 'idle' })
    assert.equal(tabRecencyLabel('idle'), 'Idle')

    const blankSession = session({
      sessionId: 'session_blank',
      processAlive: true,
      activity: { kind: 'idle', since: 0 },
      lastInputAt: null,
      lastOutputAt: null,
      exitedAt: null,
    })
    assert.deepEqual(pickTerminalTabRecency(blankSession), { at: 0, source: 'idle' })
    assert.equal(pickTerminalTabRecency(null), null)
    assert.equal(pickTerminalTabRecency(undefined), null)
  }

  function assertAgentTabRecencyFallbackChain(): void {
    const liveAgent = session({
      sessionId: 'session_live_agent',
      processAlive: true,
      activity: { kind: 'idle', since: 8_000 },
      // High lastOutputAt is ignored; recency comes from lastInputAt (last typed).
      lastInputAt: 7_950,
      lastOutputAt: 9_999,
      exitedAt: null,
    })
    assert.deepEqual(pickAgentTabRecency(liveAgent, 6_000, 5_000), { at: 8_000, source: 'idle' })

    const exitedAgent = session({
      sessionId: 'session_exited_agent',
      processAlive: false,
      activity: { kind: 'exited', at: 9_000, exitCode: 0 },
      lastInputAt: 4_000,
      exitedAt: 9_000,
    })
    assert.deepEqual(pickAgentTabRecency(exitedAgent, null, null), { at: 4_000, source: 'input' })

    const exitedAgentMissingInput = session({
      sessionId: 'session_exited_no_input',
      processAlive: false,
      activity: { kind: 'exited', at: 9_500, exitCode: 0 },
      lastInputAt: null,
      lastOutputAt: 8_000,
      exitedAt: 9_500,
    })
    assert.deepEqual(pickAgentTabRecency(exitedAgentMissingInput, null, null), { at: 9_500, source: 'exited' })

    assert.deepEqual(pickAgentTabRecency(null, 6_000, 5_000), { at: 6_000, source: 'persisted' })

    assert.deepEqual(pickAgentTabRecency(null, null, 5_000), { at: 5_000, source: 'exited' })

    assert.equal(pickAgentTabRecency(null, null, null), null)
    assert.equal(tabRecencyLabel('persisted'), 'Last activity')
    assert.equal(tabRecencyLabel('exited'), 'Exited')
  }

  async function assertSharedStoreUsesOneUnderlyingSubscription(): Promise<void> {
    const ipcListeners = new Set<(sessions: TerminalSessionSnapshot[]) => void>()
    let terminalListCalls = 0
    let unsubscribeCalls = 0
    const store = createTerminalSessionsStore(() => ({
      terminalList: async () => {
        terminalListCalls += 1
        return [session({ sessionId: 'session_initial' })]
      },
      onTerminalSessionsChanged: (listener) => {
        ipcListeners.add(listener)
        return () => {
          unsubscribeCalls += 1
          ipcListeners.delete(listener)
        }
      },
    }))

    const unsubscribers = Array.from({ length: 12 }, () => store.subscribeSemantic(() => undefined))
    assert.equal(ipcListeners.size, 1, 'many semantic subscribers must share one IPC listener')
    await flushPromises()
    assert.equal(terminalListCalls, 1, 'shared store performs one initial terminalList refresh')
    assert.deepEqual(
      store.getSemanticSnapshot().map((item) => item.sessionId),
      ['session_initial'],
    )

    await store.refresh()
    assert.equal(ipcListeners.size, 1, 'manual refresh must not add another IPC listener')

    unsubscribers.forEach((unsubscribe) => unsubscribe())
    assert.equal(ipcListeners.size, 0, 'last unsubscribe removes the shared IPC listener')
    assert.equal(unsubscribeCalls, 1)
  }

  async function assertSharedStoreDedupsSemanticUpdatesButKeepsLive(): Promise<void> {
    let ipcListener: ((sessions: TerminalSessionSnapshot[]) => void) | null = null as
      ((sessions: TerminalSessionSnapshot[]) => void) | null
    const store = createTerminalSessionsStore(() => ({
      terminalList: async () => [
        session({ sessionId: 'session_a', activity: { kind: 'idle', since: 1 }, lastOutputAt: 100 }),
      ],
      onTerminalSessionsChanged: (listener) => {
        ipcListener = listener
        return () => {
          ipcListener = null
        }
      },
    }))
    let semanticNotifications = 0
    let liveNotifications = 0
    const liveSnapshots: TerminalSessionSnapshot[][] = []

    const unsubscribeSemantic = store.subscribeSemantic(() => {
      semanticNotifications += 1
    })
    const unsubscribeLive = store.subscribeLive(() => {
      liveNotifications += 1
    })
    const unsubscribeLiveSnapshot = store.subscribeLiveSnapshot((sessions) => {
      liveSnapshots.push(sessions)
    })
    await flushPromises()
    assert.equal(semanticNotifications, 1)
    assert.equal(liveNotifications, 1)
    assert.equal(liveSnapshots.length, 1)

    semanticNotifications = 0
    liveNotifications = 0
    liveSnapshots.length = 0
    ipcListener?.([session({ sessionId: 'session_a', activity: { kind: 'idle', since: 1 }, lastOutputAt: 999 })])
    assert.equal(semanticNotifications, 0, 'semantic subscribers skip output-only churn')
    assert.equal(liveNotifications, 1, 'live subscribers receive output-only churn')
    assert.equal(liveSnapshots[0]?.[0]?.lastOutputAt, 999)

    ipcListener?.([session({ sessionId: 'session_a', activity: { kind: 'working', since: 2 }, lastOutputAt: 1000 })])
    assert.equal(semanticNotifications, 1, 'semantic subscribers receive lifecycle/activity changes')
    assert.equal(liveNotifications, 2)

    // A pull-request-only broadcast: nothing else on the snapshot moves when a
    // branch lookup answers or a pull request lands, and the sidebar line and the
    // peek head both read the semantic channel. Before this term the store's
    // `apply` early-returned here and the mark never appeared.
    semanticNotifications = 0
    ipcListener?.([
      session({
        sessionId: 'session_a',
        activity: { kind: 'working', since: 2 },
        lastOutputAt: 1000,
        pullRequests: [
          {
            url: 'https://github.com/acme/sprintengine/pull/418',
            repoKey: 'github.com/acme/sprintengine',
            repoName: 'sprintengine',
            number: 418,
            title: '',
            state: 'open',
            isDraft: false,
            openedAt: 10,
            stateAt: 20,
          },
        ],
      }),
    ])
    assert.equal(semanticNotifications, 1, 'a pull request arriving is semantic news')

    unsubscribeSemantic()
    unsubscribeLive()
    unsubscribeLiveSnapshot()
  }

  async function assertSharedStoreHandlesDuplicateSubscriberCallbacks(): Promise<void> {
    let ipcListener: ((sessions: TerminalSessionSnapshot[]) => void) | null = null as
      ((sessions: TerminalSessionSnapshot[]) => void) | null
    let unsubscribeCalls = 0
    const store = createTerminalSessionsStore(() => ({
      terminalList: async () => [],
      onTerminalSessionsChanged: (listener) => {
        ipcListener = listener
        return () => {
          unsubscribeCalls += 1
          ipcListener = null
        }
      },
    }))
    let calls = 0
    const listener = () => {
      calls += 1
    }
    const unsubscribeFirst = store.subscribeSemantic(listener)
    const unsubscribeSecond = store.subscribeSemantic(listener)
    await flushPromises()

    ipcListener?.([session({ sessionId: 'session_duplicate_a' })])
    assert.equal(calls, 2, 'the same callback subscribed twice represents two subscriptions')

    unsubscribeFirst()
    ipcListener?.([session({ sessionId: 'session_duplicate_b' })])
    assert.equal(calls, 3, 'unsubscribing one duplicate leaves the other active')
    assert.equal(unsubscribeCalls, 0)

    unsubscribeSecond()
    assert.equal(unsubscribeCalls, 1, 'underlying IPC listener is removed after the last duplicate unsubscribe')
  }

  async function assertSharedStoreIgnoresDisconnectedInitialRefresh(): Promise<void> {
    const pendingTerminalLists: Array<(sessions: TerminalSessionSnapshot[]) => void> = []
    const store = createTerminalSessionsStore(() => ({
      terminalList: () =>
        new Promise<TerminalSessionSnapshot[]>((resolve) => {
          pendingTerminalLists.push(resolve)
        }),
      onTerminalSessionsChanged: () => () => undefined,
    }))

    const unsubscribeFirst = store.subscribeSemantic(() => undefined)
    const manualRefresh = store.refresh()
    unsubscribeFirst()
    pendingTerminalLists[0]?.([session({ sessionId: 'session_stale_after_disconnect' })])
    pendingTerminalLists[1]?.([session({ sessionId: 'session_manual_stale_after_disconnect' })])
    await manualRefresh
    await flushPromises()
    assert.deepEqual(
      store.getSemanticSnapshot(),
      [],
      'late initial refresh from a disconnected subscription must not repopulate the store',
    )

    const liveSnapshots: TerminalSessionSnapshot[][] = []
    const unsubscribeSecond = store.subscribeLiveSnapshot((sessions) => {
      liveSnapshots.push(sessions)
    })
    assert.deepEqual(
      liveSnapshots,
      [] as TerminalSessionSnapshot[][],
      'new subscriber must not receive stale disconnected snapshot',
    )

    pendingTerminalLists[2]?.([session({ sessionId: 'session_fresh_after_reconnect' })])
    await flushPromises()
    assert.deepEqual(
      liveSnapshots.map((sessions) => sessions.map((item) => item.sessionId)),
      [['session_fresh_after_reconnect']],
    )
    unsubscribeSecond()
  }

  async function assertStaleLaunchFlagsClearWithoutLosingRecency(): Promise<void> {
    installTestLocalStorage()
    const { useWorkspaceStore } = await import('../store/workspaceStore')
    const previousState = useWorkspaceStore.getState()
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: 'workspace_1',
          agents: {
            'developer-1': {
              cli: 'unsupported-cli',
              cliStartRequested: true,
              cliHasLaunched: true,
              cliSessionId: 'session_stale',
            },
            'developer-2': {
              cliStartRequested: true,
              cliHasLaunched: true,
              cliSessionId: 'session_live',
            },
          },
          lastTerminalActivityAt: 1_000,
        },
      ],
    } as never)

    useWorkspaceStore.getState().reconcileWorkspaceAgentLaunchFlags([
      session({
        sessionId: 'session_live',
        agentId: 'developer-2',
        processAlive: true,
      }),
    ])

    const workspace = useWorkspaceStore.getState().workspaces[0]
    assert.equal(workspace.lastTerminalActivityAt, 1_000)
    assert.equal(workspace.agents['developer-1'].cliStartRequested, false)
    assert.equal(workspace.agents['developer-1'].cliHasLaunched, false)
    // The stale agent loses its launch/resume GATE but keeps its session identity:
    // `cliSessionId` resolves the painted screen on disk, and dropping it here sent
    // the mounting terminal back to minting a fresh uuid and spawning a fresh CLI.
    // Nothing auto-resumes off the id alone — the flags above are the resume gate.
    assert.equal(workspace.agents['developer-1'].cliSessionId, 'session_stale')
    assert.equal(workspace.agents['developer-2'].cliStartRequested, true)
    assert.equal(workspace.agents['developer-2'].cliHasLaunched, true)
    assert.equal(workspace.agents['developer-2'].cliSessionId, 'session_live')

    useWorkspaceStore.setState({
      workspaces: previousState.workspaces,
      activeWorkspaceId: previousState.activeWorkspaceId,
    })
  }

  async function assertClaudeSessionIdentitySurvivesStartupReconciliation(): Promise<void> {
    installTestLocalStorage()
    const { useWorkspaceStore } = await import('../store/workspaceStore')
    const previousState = useWorkspaceStore.getState()
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: 'workspace_1',
          agents: {
            'developer-claude': {
              cli: 'claude-code',
              cliStartRequested: true,
              cliHasLaunched: true,
              cliSessionId: 'claude_original_session',
              cliResumeAvailable: true,
            },
          },
        },
      ],
    } as never)

    useWorkspaceStore.getState().reconcileWorkspaceAgentLaunchFlags([])

    const agent = useWorkspaceStore.getState().workspaces[0].agents['developer-claude']
    assert.equal(agent.cliStartRequested, true)
    assert.equal(agent.cliHasLaunched, true)
    assert.equal(agent.cliSessionId, 'claude_original_session')
    assert.equal(agent.cliResumeAvailable, true)

    useWorkspaceStore.setState({
      workspaces: previousState.workspaces,
      activeWorkspaceId: previousState.activeWorkspaceId,
    })
  }

  async function assertClaudeCodeSessionIdentitySurvivesStartupReconciliation(): Promise<void> {
    installTestLocalStorage()
    const { useWorkspaceStore } = await import('../store/workspaceStore')
    const previousState = useWorkspaceStore.getState()
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: 'workspace_1',
          agents: {
            'developer-claude-code': {
              cli: 'claude-code',
              cliStartRequested: true,
              cliHasLaunched: true,
              cliSessionId: 'claude_code_original_session',
              cliResumeAvailable: true,
            },
          },
        },
      ],
    } as never)

    useWorkspaceStore.getState().reconcileWorkspaceAgentLaunchFlags([])

    const agent = useWorkspaceStore.getState().workspaces[0].agents['developer-claude-code']
    assert.equal(agent.cliStartRequested, true)
    assert.equal(agent.cliHasLaunched, true)
    assert.equal(agent.cliSessionId, 'claude_code_original_session')
    assert.equal(agent.cliResumeAvailable, true)

    useWorkspaceStore.setState({
      workspaces: previousState.workspaces,
      activeWorkspaceId: previousState.activeWorkspaceId,
    })
  }

  function session(input: Partial<TerminalSessionSnapshot> & { sessionId: string }): TerminalSessionSnapshot {
    return {
      sessionId: input.sessionId,
      processAlive: input.processAlive ?? true,
      kind: input.kind ?? 'agent',
      workspaceId: input.workspaceId ?? 'workspace_1',
      agentId: input.agentId ?? 'developer-1',
      visible: input.visible ?? true,
      suspended: input.suspended ?? false,
      reapExempt: input.reapExempt ?? false,
      startedAt: input.startedAt ?? 0,
      lastOutputAt: input.lastOutputAt ?? null,
      lastInputAt: input.lastInputAt ?? null,
      lastVisibleAt: input.lastVisibleAt ?? null,
      lastTurnEndedAt: input.lastTurnEndedAt ?? null,
      activity: input.activity ?? { kind: 'idle', since: 0 },
      agentState: input.agentState,
      lastPrompt: input.lastPrompt,
      observedCheckout: input.observedCheckout,
      fileChanges: input.fileChanges ?? [],
      activeSubagents: input.activeSubagents ?? 0,
      contextUsage: input.contextUsage ?? null,
      pullRequests: input.pullRequests,
      exitedAt: input.exitedAt ?? null,
      outputBufferLength: input.outputBufferLength ?? 0,
      retainedOutputBytes: input.retainedOutputBytes ?? 0,
      agentSession: input.agentSession ?? {
        sessionId: input.sessionId,
        executionId: 'exec_1',
        system: 'manual',
        workspaceId: input.workspaceId ?? 'workspace_1',
        workspaceRoot: '/workspace',
        displayName: 'Agent',
      },
    }
  }

  async function flushPromises(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
  }

  function installTestLocalStorage(): void {
    const storage = new Map<string, string>()
    const localStorage = {
      get length() {
        return storage.size
      },
      clear: () => {
        storage.clear()
      },
      getItem: (key: string) => storage.get(key) ?? null,
      key: (index: number) => [...storage.keys()][index] ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value)
      },
      removeItem: (key: string) => {
        storage.delete(key)
      },
    }
    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage,
        location: { href: 'http://localhost/?windowId=primary' },
        addEventListener: () => {},
      },
      configurable: true,
    })
  }

  await suiteRun
})
