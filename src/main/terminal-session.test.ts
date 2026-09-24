import assert from 'node:assert/strict'
import {
  appendTerminalOutput,
  createFailedTerminalSession,
  createInitialTerminalActivity,
  createSuspendedPlaceholderSession,
  getTerminalLastSeenAt,
  getTerminalSnapshot,
  isTerminalProcessAlive,
  isTerminalSessionStale,
  markTerminalExited,
  markTerminalFailed,
  listSessionFileChanges,
  materializeTerminalReplay,
  readTerminalOutputSince,
  resyncTerminalReplayHead,
  MAX_SESSION_FILE_CHANGE_PATH_CHARS,
  MAX_SESSION_FILE_CHANGES,
  parseSessionContextUsage,
  parseSessionFileChanges,
  parseSessionPrompts,
  recordSessionFileChange,
  recordSessionStatusLine,
  setSessionPullRequestReader,
  recordTerminalInput,
  recordTerminalVisibility,
  transitionTerminalActivity,
  STALE_TERMINAL_MAX_UNSEEN_MS,
  type TerminalSession,
} from './terminal-session'
import { MAX_AGENT_PROMPT_LENGTH } from './agent-state'
import { MAX_LIVE_PEEK_PROMPTS } from './conversation-peek/service'
import { createTerminalDiagnostics } from './terminal-diagnostics'
import { TerminalReplayBuffer } from './terminal-replay-buffer'
import {
  TERMINAL_RECENT_HISTORY_WINDOW_MS,
  TERMINAL_RECENT_REPLAY_BYTES,
  TERMINAL_STANDARD_REPLAY_BYTES,
} from '../shared/terminal-history'
import { test } from 'vitest'

test('terminal-session', async () => {
  void main()

  function main(): void {
    assertSpawnSnapshotStartsWorking()
    assertOutputWhileWorkingUpdatesRecencyWithoutStateTransition()
    assertSilenceAndLaterOutputTransitionBetweenIdleAndWorking()
    assertInputRecordsRecencyWithoutChangingActivity()
    assertExitAndFailureClassificationClearTimers()
    assertFailedLaunchSnapshotIsVisible()
    assertActivityTransitionDiagnostics()
    assertRecentSessionsRetainExtendedReplay()
    assertColdSessionsCompactToStandardReplay()
    assertOutputSinceACursorIsOnlyTheNewOutput()
    assertRecentInputKeepsSessionInExtendedReplayTier()
    assertColdSingleLargeChunkIsTrimmedNotDropped()
    assertCutReplayNeverStartsMidEscapeSequence()
    assertUncutReplayIsHandedBackByteForByte()
    assertColdSessionNewOutputUsesRecentReplayTier()
    assertVisibilityRecordingUpdatesRecency()
    assertStaleRuleExemptsVisibleSessionsWithLiveSender()
    assertStaleRuleUsesMostRecentUserSignal()
    assertStaleRuleCountsFromTheLastMomentOnScreen()
    assertSuspendedSessionIsNotAlive()
    assertPlaceholderIdlesSinceTheTurnEnd()
    assertFileLedgerAccumulatesAndStaysBounded()
    assertPersistedLedgerIsReadBackAsUntrustedInput()
    assertPersistedPromptsAreReadBackAsUntrustedInput()
    assertRehydratedPlaceholderKeepsItsPrompts()
    assertStatusLineReadingsMergeAndGateTheBroadcast()
    assertPersistedContextUsageIsReadBackAsUntrustedInput()
    assertSnapshotCarriesThePullRequestRecordsAnswer()
  }

  // The snapshot's `pullRequests` come from whatever the app registered as the
  // record reader, and from nothing else: with no record wired — a test, a plain
  // terminal, main before the record exists — every snapshot carries an empty
  // list rather than an absent field.
  function assertSnapshotCarriesThePullRequestRecordsAnswer(): void {
    const session = createSession({ startedAt: 1_000 })
    assert.deepEqual(getTerminalSnapshot(session).pullRequests, [], 'no record wired: an empty list, never a guess')

    const pullRequest = {
      url: 'https://github.com/acme/app/pull/12',
      repoKey: 'github.com/acme/app',
      repoName: 'app',
      number: 12,
      title: 'Marks',
      state: 'open' as const,
      isDraft: false,
      openedAt: 10,
      stateAt: 20,
    }
    try {
      setSessionPullRequestReader((asked) => (asked === session ? [pullRequest] : []))
      assert.deepEqual(
        getTerminalSnapshot(session).pullRequests,
        [pullRequest],
        "the record's answer rides the snapshot",
      )

      setSessionPullRequestReader(() => {
        throw new Error('the store fell over')
      })
      assert.deepEqual(
        getTerminalSnapshot(session).pullRequests,
        [],
        'a store that threw costs a list, never a session',
      )
    } finally {
      setSessionPullRequestReader(null)
    }
  }

  // The per-session file ledger: counts accumulate, the newest edit is at the
  // front, and the whole thing is bounded — it rides every snapshot broadcast.
  function assertFileLedgerAccumulatesAndStaysBounded(): void {
    const session = createSession({ startedAt: 1_000 })
    assert.deepEqual(listSessionFileChanges(session), [], 'a session that has edited nothing has an empty ledger')
    assert.deepEqual(getTerminalSnapshot(session).fileChanges, [])
    assert.equal(getTerminalSnapshot(session).activeSubagents, 0)
    assert.equal(getTerminalSnapshot(session).contextUsage, null)

    recordSessionFileChange(session, { path: '/repo/a.ts', additions: 4, deletions: 1 }, 100)
    recordSessionFileChange(session, { path: '/repo/b.ts', additions: 2, deletions: 0 }, 200)
    recordSessionFileChange(session, { path: '/repo/a.ts', additions: 3, deletions: 2 }, 300)
    assert.deepEqual(
      listSessionFileChanges(session),
      [
        { path: '/repo/a.ts', additions: 7, deletions: 3, edits: 2, lastEditedAt: 300 },
        { path: '/repo/b.ts', additions: 2, deletions: 0, edits: 1, lastEditedAt: 200 },
      ],
      'counts accumulate per file and the most recently edited file is first',
    )

    // An out-of-order frame still counts, and cannot drag the recency backwards.
    recordSessionFileChange(session, { path: '/repo/a.ts', additions: 1, deletions: 0 }, 250)
    assert.deepEqual(
      listSessionFileChanges(session)[0],
      { path: '/repo/a.ts', additions: 8, deletions: 3, edits: 3, lastEditedAt: 300 },
      'a late-arriving earlier edit adds its lines without moving the time back',
    )

    // Bounded by count…
    const counted = createSession({ startedAt: 1_000 })
    for (let i = 0; i < MAX_SESSION_FILE_CHANGES + 20; i += 1) {
      recordSessionFileChange(counted, { path: `/repo/file-${i}.ts`, additions: 1, deletions: 1 }, 1_000 + i)
    }
    const countedList = listSessionFileChanges(counted)
    assert.equal(countedList.length, MAX_SESSION_FILE_CHANGES)
    assert.equal(countedList[0]?.path, `/repo/file-${MAX_SESSION_FILE_CHANGES + 19}.ts`)
    assert.deepEqual(
      countedList[countedList.length - 1],
      { path: '/repo/file-20.ts', additions: 1, deletions: 1, edits: 1, lastEditedAt: 1_020 },
      'a survivor keeps its own counts — eviction takes entries, not their contents',
    )

    // …and by the characters those paths cost, which the count alone does not
    // bound: a path may be 4096 characters long.
    const wide = createSession({ startedAt: 1_000 })
    const longPath = (index: number) => `/repo/${String(index).padStart(6, '0')}/${'x'.repeat(4000)}.ts`
    for (let i = 0; i < 40; i += 1) {
      recordSessionFileChange(wide, { path: longPath(i), additions: 1, deletions: 0 }, 2_000 + i)
    }
    const wideList = listSessionFileChanges(wide)
    assert.ok(wideList.length < 40, 'long paths hit the character budget well before the count cap')
    assert.ok(
      wideList.reduce((total, change) => total + change.path.length, 0) <= MAX_SESSION_FILE_CHANGE_PATH_CHARS,
      'the ledger stays inside its character budget',
    )
    assert.equal(wideList[0]?.path, longPath(39), 'and the newest edit is what survives')
  }

  // The sidecar is a file on disk: no more trusted than the socket, and read back
  // through the same rules.
  function assertPersistedLedgerIsReadBackAsUntrustedInput(): void {
    assert.equal(parseSessionFileChanges(undefined), undefined)
    assert.equal(parseSessionFileChanges('not an array'), undefined)
    assert.equal(parseSessionFileChanges([]), undefined, 'an empty ledger is no ledger')

    const good = { path: '/repo/a.ts', additions: 4, deletions: 1, edits: 2, lastEditedAt: 300 }
    const rejected = [
      null,
      'string',
      { ...good, path: 'repo/relative.ts' },
      { ...good, path: '' },
      { ...good, path: '/repo/\u0000nul.ts' },
      { ...good, path: '/repo/\u001b[31mescape.ts' },
      { ...good, path: '/' + 'x'.repeat(9000) },
      { ...good, additions: -1 },
      { ...good, deletions: Number.NaN },
      { ...good, edits: '2' },
      { ...good, lastEditedAt: undefined },
    ]
    for (const entry of rejected) {
      assert.equal(
        parseSessionFileChanges([entry, good])?.size,
        1,
        `a malformed entry is dropped without taking the ledger with it: ${JSON.stringify(entry)}`,
      )
    }

    const parsed = parseSessionFileChanges([
      { path: '/repo/newest.ts', additions: 1.7, deletions: 0, edits: 1, lastEditedAt: 400.5 },
      good,
    ])
    assert.deepEqual(
      [...(parsed?.values() ?? [])].reverse(),
      [{ path: '/repo/newest.ts', additions: 1, deletions: 0, edits: 1, lastEditedAt: 400 }, good],
      'the persisted order survives the round trip, and fractional counts floor',
    )

    const oversized = Array.from({ length: MAX_SESSION_FILE_CHANGES + 200 }, (_unused, index) => ({
      path: `/repo/file-${index}.ts`,
      additions: 1,
      deletions: 0,
      edits: 1,
      lastEditedAt: 1_000 - index,
    }))
    const capped = parseSessionFileChanges(oversized)
    assert.equal(capped?.size, MAX_SESSION_FILE_CHANGES, 'a sidecar cannot grow the ledger past its cap')
    assert.ok(capped?.has('/repo/file-0.ts'), 'and what it keeps is the head of the newest-first list')
  }

  // Prompts ride the sidecar so a parked Codex chat still knows what it was asked
  // — and a sidecar is a file on disk, read back under the live path's own rules.
  function assertPersistedPromptsAreReadBackAsUntrustedInput(): void {
    assert.equal(parseSessionPrompts(undefined), undefined)
    assert.equal(parseSessionPrompts('not an array'), undefined)
    assert.equal(parseSessionPrompts([]), undefined, 'no prompts is no list')

    const good = { text: 'Port voice dictation to Studio', at: 300 }
    const rejected = [
      null,
      'string',
      { ...good, text: 42 },
      { ...good, text: '   ' },
      { ...good, at: '300' },
      { ...good, at: Number.NaN },
      { ...good, at: -1 },
      { text: good.text },
    ]
    for (const entry of rejected) {
      assert.deepEqual(
        parseSessionPrompts([entry, good]),
        [good],
        `a malformed entry is dropped without taking the list with it: ${JSON.stringify(entry)}`,
      )
    }

    assert.deepEqual(
      parseSessionPrompts([{ text: 'first', at: 10.9 }, good]),
      [{ text: 'first', at: 10 }, good],
      'the persisted order survives the round trip, and a fractional stamp floors',
    )

    const oversized = Array.from({ length: MAX_LIVE_PEEK_PROMPTS + 40 }, (_unused, index) => ({
      text: `prompt ${index}`,
      at: index,
    }))
    const capped = parseSessionPrompts(oversized)
    assert.equal(capped?.length, MAX_LIVE_PEEK_PROMPTS, 'a sidecar cannot grow the list past the live cap')
    assert.equal(capped?.[0]?.text, 'prompt 0', 'and the first message — the one the card quotes — is kept')

    const long = parseSessionPrompts([{ text: 'x'.repeat(50_000), at: 1 }])
    assert.equal(long?.[0]?.text.length, MAX_AGENT_PROMPT_LENGTH, 'a novel in the file is still truncated')
  }

  // The restart path: the placeholder a sidecar rehydrates into is what the
  // conversation peek reads, so prompts that reached disk must reach the session.
  function assertRehydratedPlaceholderKeepsItsPrompts(): void {
    const prompts = [
      { text: 'Port voice dictation to Studio', at: 10 },
      { text: 'Now wire up the settings pane', at: 20 },
    ]
    const session = createSuspendedPlaceholderSession({
      sessionId: 'session_parked',
      savedAt: 1_000,
      cli: 'codex',
      peekPrompts: prompts,
      replaySnapshot: 'painted',
    })
    assert.deepEqual(session.peekPrompts, prompts, 'the peek has its history back')
    assert.deepEqual(
      session.lastPrompt,
      prompts[1],
      'and the tab hover names the newest, not the one that started the chat',
    )

    const empty = createSuspendedPlaceholderSession({
      sessionId: 'session_quiet',
      savedAt: 1_000,
      replaySnapshot: 'painted',
    })
    assert.equal(empty.peekPrompts, undefined, 'a sidecar with no prompts invents none')
    assert.equal(empty.lastPrompt, undefined)
  }

  // A status-line reading MERGES into the session and only a moved whole percent
  // is worth a broadcast. The null-after-compact rule is the load-bearing part:
  // the CLI reports no percentage before its first API call and again right after
  // a /compact, and "not known right now" must not erase the number a person was
  // watching a second ago.
  function assertStatusLineReadingsMergeAndGateTheBroadcast(): void {
    // A session whose first refresh lands before its first API call knows the
    // cost and the model but not the percentage, and must not invent one.
    const unread = createSession({ startedAt: 0 })
    assert.equal(recordSessionStatusLine(unread, { totalCostUsd: 0, model: 'Opus' }, 50), false)
    assert.equal(unread.contextUsage, undefined, 'no percentage yet is not a percentage of zero')
    assert.equal(getTerminalSnapshot(unread).contextUsage, null)

    const session = createSession({ startedAt: 0 })

    assert.equal(
      recordSessionStatusLine(session, { usedPercentage: 8, totalCostUsd: 0.5, model: 'Opus' }, 100),
      true,
      'a first reading moves the snapshot',
    )
    assert.deepEqual(session.contextUsage, { usedPercentage: 8, at: 100 })
    assert.equal(session.statusLine?.model, 'Opus')

    assert.equal(
      recordSessionStatusLine(session, { usedPercentage: 8, totalCostUsd: 0.9, linesAdded: 40 }, 200),
      false,
      'the same whole percent is not news, however much the cost moved',
    )
    assert.deepEqual(session.contextUsage, { usedPercentage: 8, at: 100 }, 'and the timestamp does not drift')
    assert.equal(session.statusLine?.totalCostUsd, 0.9, 'but the reading itself is kept current')
    assert.equal(session.statusLine?.linesAdded, 40)

    // A /compact: no percentage in the payload at all.
    assert.equal(recordSessionStatusLine(session, { totalCostUsd: 1.1 }, 300), false)
    assert.deepEqual(
      session.contextUsage,
      { usedPercentage: 8, at: 100 },
      'a reading with no percentage keeps the last known one',
    )
    assert.equal(session.statusLine?.model, 'Opus', 'and takes nothing else with it either')

    assert.equal(recordSessionStatusLine(session, { usedPercentage: 3 }, 400), true)
    assert.deepEqual(session.contextUsage, { usedPercentage: 3, at: 400 }, 'the next real reading replaces it')

    // Out of order: a status-line process is spawned per refresh, so they can
    // finish in any order, and an older reading carries older facts.
    assert.equal(recordSessionStatusLine(session, { usedPercentage: 71, totalCostUsd: 0.1 }, 350), false)
    assert.deepEqual(session.contextUsage, { usedPercentage: 3, at: 400 })
    assert.equal(session.statusLine?.totalCostUsd, 1.1, 'a stale reading does not roll the cost back either')
  }

  // The sidecar is a file on disk here too.
  function assertPersistedContextUsageIsReadBackAsUntrustedInput(): void {
    assert.equal(parseSessionContextUsage(undefined), undefined)
    assert.equal(parseSessionContextUsage(null), undefined)
    assert.equal(parseSessionContextUsage('8%'), undefined)
    assert.equal(parseSessionContextUsage({ usedPercentage: 8 }), undefined, 'a reading needs its time')
    assert.equal(parseSessionContextUsage({ at: 5 }), undefined)
    assert.equal(parseSessionContextUsage({ usedPercentage: -1, at: 5 }), undefined)
    assert.equal(parseSessionContextUsage({ usedPercentage: 101, at: 5 }), undefined)
    assert.equal(parseSessionContextUsage({ usedPercentage: Number.NaN, at: 5 }), undefined)
    assert.equal(parseSessionContextUsage({ usedPercentage: 8, at: -1 }), undefined)
    assert.equal(parseSessionContextUsage({ usedPercentage: 8, at: '5' }), undefined)
    assert.deepEqual(parseSessionContextUsage({ usedPercentage: 8.6, at: 400.5 }), { usedPercentage: 9, at: 400 })
    assert.deepEqual(parseSessionContextUsage({ usedPercentage: 0, at: 0 }), { usedPercentage: 0, at: 0 })
    // Clamped to arrival like a reporter frame's ts: a hand-edited sidecar timed
    // in the year 275760 would be written back out on the next suspend and ride
    // into every window from there.
    assert.deepEqual(
      parseSessionContextUsage({ usedPercentage: 8, at: 8.6e15 }, 1_000),
      { usedPercentage: 8, at: 1_000 },
      'a far-future sidecar time is clamped, not believed',
    )

    // And it comes back onto a rehydrated placeholder.
    const placeholder = createSuspendedPlaceholderSession({
      sessionId: 'status-line-placeholder',
      savedAt: 1_000,
      contextUsage: { usedPercentage: 42, at: 900 },
    })
    assert.deepEqual(getTerminalSnapshot(placeholder).contextUsage, { usedPercentage: 42, at: 900 })
    assert.equal(
      getTerminalSnapshot(createSuspendedPlaceholderSession({ sessionId: 'no-reading', savedAt: 1_000 })).contextUsage,
      null,
      'a session nothing read reports null, never a guess',
    )
  }

  // Owner, 2026-09-05: the quit path writes every agent's sidecar at one moment,
  // so a placeholder idling from `savedAt` made every rehydrated row read the
  // same time. With the turn end on the sidecar the placeholder idles from the
  // finish; without it, savedAt remains the honest fallback.
  function assertPlaceholderIdlesSinceTheTurnEnd(): void {
    const withTurnEnd = createSuspendedPlaceholderSession({
      sessionId: 'placeholder-1',
      savedAt: 9_000,
      lastTurnEndedAt: 4_000,
      replaySnapshot: 'painted',
    })
    assert.deepEqual(withTurnEnd.activity, { kind: 'idle', since: 4_000 })
    assert.equal(withTurnEnd.agentState?.since, 4_000)
    assert.equal(getTerminalSnapshot(withTurnEnd).lastTurnEndedAt, 4_000, 'the snapshot carries it to the renderer')

    const withoutTurnEnd = createSuspendedPlaceholderSession({
      sessionId: 'placeholder-2',
      savedAt: 9_000,
      replaySnapshot: 'painted',
    })
    assert.deepEqual(withoutTurnEnd.activity, { kind: 'idle', since: 9_000 })
    assert.equal(getTerminalSnapshot(withoutTurnEnd).lastTurnEndedAt, null)
  }

  function assertSpawnSnapshotStartsWorking(): void {
    const session = createSession({ startedAt: 100 })
    const snapshot = getTerminalSnapshot(session)

    assert.equal(snapshot.processAlive, true)
    assert.equal(snapshot.lastOutputAt, 100)
    assert.equal(snapshot.lastInputAt, null)
    assert.deepEqual(snapshot.activity, { kind: 'working', since: 100 })
  }

  function assertOutputWhileWorkingUpdatesRecencyWithoutStateTransition(): void {
    const session = createSession({ startedAt: 100 })

    appendTerminalOutput(session, 'first output', 150)
    // Output advances recency; the activity transition is the runtime's call
    // (plain terminals only — agent activity is hook-bridged), and re-asserting
    // the same working state is a no-op.
    assert.equal(transitionTerminalActivity(session, { kind: 'working', since: 100 }), false)
    assert.equal(session.lastOutputAt, 150)
    assert.deepEqual(session.activity, { kind: 'working', since: 100 })
  }

  function assertSilenceAndLaterOutputTransitionBetweenIdleAndWorking(): void {
    const session = createSession({ startedAt: 100 })

    assert.equal(transitionTerminalActivity(session, { kind: 'idle', since: 3_200 }), true)
    assert.deepEqual(session.activity, { kind: 'idle', since: 3_200 })

    appendTerminalOutput(session, 'later output', 4_000)
    assert.equal(transitionTerminalActivity(session, { kind: 'working', since: 4_000 }), true)
    assert.equal(session.lastOutputAt, 4_000)
    assert.deepEqual(session.activity, { kind: 'working', since: 4_000 })
  }

  function assertInputRecordsRecencyWithoutChangingActivity(): void {
    const session = createSession({ startedAt: 100 })

    recordTerminalInput(session, 225)

    assert.equal(session.lastInputAt, 225)
    assert.equal(session.lastOutputAt, 100)
    assert.deepEqual(session.activity, { kind: 'working', since: 100 })
  }

  function assertExitAndFailureClassificationClearTimers(): void {
    const exited = createSession({ startedAt: 100, idleTimer: setTimeout(() => {}, 10_000) })
    markTerminalExited(exited, 0, 500)

    assert.equal(exited.hasExited, true)
    assert.equal(exited.idleTimer, undefined)
    assert.equal(getTerminalSnapshot(exited).processAlive, false)
    assert.deepEqual(exited.activity, { kind: 'exited', at: 500, exitCode: 0 })

    const failed = createSession({ startedAt: 100, idleTimer: setTimeout(() => {}, 10_000) })
    markTerminalFailed(failed, 1, 'write failed', 600)

    assert.equal(failed.hasExited, true)
    assert.equal(failed.idleTimer, undefined)
    assert.equal(getTerminalSnapshot(failed).processAlive, false)
    assert.deepEqual(failed.activity, { kind: 'failed', at: 600, exitCode: 1, message: 'write failed' })
  }

  function assertFailedLaunchSnapshotIsVisible(): void {
    const failed = createFailedTerminalSession({
      sessionId: 'session_failed_launch',
      message: 'MCP sync failed',
      at: 700,
      kind: 'agent',
      workspaceId: 'workspace_1',
      agentId: 'developer-1',
      visible: true,
    })
    const snapshot = getTerminalSnapshot(failed)

    assert.equal(snapshot.sessionId, 'session_failed_launch')
    assert.equal(snapshot.processAlive, false)
    assert.equal(snapshot.lastOutputAt, 700)
    assert.equal(snapshot.lastInputAt, null)
    assert.equal(snapshot.workspaceId, 'workspace_1')
    assert.equal(snapshot.agentId, 'developer-1')
    assert.deepEqual(snapshot.activity, {
      kind: 'failed',
      at: 700,
      exitCode: 1,
      message: 'MCP sync failed',
    })
  }

  function assertActivityTransitionDiagnostics(): void {
    const events: Array<{ event: string; payload: Record<string, unknown> }> = []
    const diagnostics = createTerminalDiagnostics({
      enabled: true,
      logMainPerfEvent: (_scope, event, payload) => {
        events.push({ event, payload })
      },
    })
    const session = createSession({ startedAt: 100 })
    recordTerminalInput(session, 125)

    for (const next of [
      { kind: 'idle' as const, since: 200 },
      { kind: 'working' as const, since: 300 },
      { kind: 'exited' as const, at: 400, exitCode: 0 },
    ]) {
      const previous = session.activity
      const changed = transitionTerminalActivity(session, next)
      assert.equal(changed, true)
      diagnostics.recordActivityTransition(session, previous, session.activity)
    }

    const failed = createSession({ startedAt: 500 })
    const previous = failed.activity
    assert.equal(
      transitionTerminalActivity(failed, { kind: 'failed', at: 600, exitCode: 1, message: 'spawn failed' }),
      true,
    )
    diagnostics.recordActivityTransition(failed, previous, failed.activity)

    assert.deepEqual(
      events.map((entry) => entry.event),
      ['activity-transition', 'activity-transition', 'activity-transition', 'activity-transition'],
    )
    assert.deepEqual(
      events.map((entry) => [
        entry.payload.sessionId,
        entry.payload.previousKind,
        entry.payload.nextKind,
        entry.payload.lastOutputAt,
        entry.payload.lastInputAt,
        entry.payload.exitCode,
        entry.payload.message,
      ]),
      [
        ['session_1', 'working', 'idle', 100, 125, undefined, undefined],
        ['session_1', 'idle', 'working', 100, 125, undefined, undefined],
        ['session_1', 'working', 'exited', 100, 125, 0, undefined],
        ['session_1', 'working', 'failed', 500, null, 1, 'spawn failed'],
      ],
    )
  }

  function assertRecentSessionsRetainExtendedReplay(): void {
    const session = createSession({ startedAt: Date.now() })
    const chunk = 'r'.repeat(TERMINAL_STANDARD_REPLAY_BYTES)

    for (let index = 0; index < 5; index += 1) {
      appendTerminalOutput(session, chunk, Date.now())
    }

    assert.equal(session.output.retainedBytes, TERMINAL_RECENT_REPLAY_BYTES)
    assert.equal(getTerminalSnapshot(session).historyTier, 'recent')
    assert.equal(materializeTerminalReplay(session).length, TERMINAL_RECENT_REPLAY_BYTES)
  }

  function assertOutputSinceACursorIsOnlyTheNewOutput(): void {
    const coldAt = Date.now() - TERMINAL_RECENT_HISTORY_WINDOW_MS - 1_000
    const session = createSession({ startedAt: coldAt })
    appendTerminalOutput(session, 'one\n', coldAt)
    appendTerminalOutput(session, 'two\n', coldAt)
    const all = readTerminalOutputSince(session, 0)
    assert.deepEqual(all, { text: 'one\ntwo\n', cursor: 8, truncated: false })

    appendTerminalOutput(session, 'thr', coldAt)
    appendTerminalOutput(session, 'ee\n', coldAt)
    assert.deepEqual(readTerminalOutputSince(session, all.cursor), { text: 'three\n', cursor: 14, truncated: false })
    // A cursor inside a chunk is honoured to the character.
    assert.equal(readTerminalOutputSince(session, 10).text, 'ree\n')
    assert.deepEqual(readTerminalOutputSince(session, 14), { text: '', cursor: 14, truncated: false })

    // Once eviction has dropped part of the gap, the reader gets what is still
    // retained and is told it missed some.
    const chunk = 'x'.repeat(TERMINAL_RECENT_REPLAY_BYTES)
    appendTerminalOutput(session, chunk, coldAt)
    appendTerminalOutput(session, 'tail', coldAt)
    const late = readTerminalOutputSince(session, 14)
    assert.equal(late.truncated, true)
    assert.equal(late.cursor, 14 + chunk.length + 4)
    assert.ok(late.text.endsWith('tail'))
    assert.equal(late.text.length, session.output.retainedUnits)
  }

  function assertColdSessionsCompactToStandardReplay(): void {
    const coldAt = Date.now() - TERMINAL_RECENT_HISTORY_WINDOW_MS - 1_000
    const session = createSession({ startedAt: coldAt })
    const chunk = 's'.repeat(TERMINAL_STANDARD_REPLAY_BYTES)

    for (let index = 0; index < 5; index += 1) {
      appendTerminalOutput(session, chunk, coldAt)
    }

    const replay = materializeTerminalReplay(session)
    assert.equal(getTerminalSnapshot(session).historyTier, 'standard')
    assert.equal(session.output.retainedBytes, TERMINAL_STANDARD_REPLAY_BYTES)
    assert.equal(replay.length, TERMINAL_STANDARD_REPLAY_BYTES)
  }

  function assertRecentInputKeepsSessionInExtendedReplayTier(): void {
    const coldAt = Date.now() - TERMINAL_RECENT_HISTORY_WINDOW_MS - 1_000
    const session = createSession({ startedAt: coldAt })
    recordTerminalInput(session, Date.now())

    appendTerminalOutput(session, 'i'.repeat(TERMINAL_RECENT_REPLAY_BYTES), coldAt)

    assert.equal(getTerminalSnapshot(session).historyTier, 'recent')
    assert.equal(session.output.retainedBytes, TERMINAL_RECENT_REPLAY_BYTES)
  }

  function assertColdSingleLargeChunkIsTrimmedNotDropped(): void {
    const coldAt = Date.now() - TERMINAL_RECENT_HISTORY_WINDOW_MS - 1_000
    const session = createSession({ startedAt: coldAt })

    appendTerminalOutput(session, 'x'.repeat(TERMINAL_RECENT_REPLAY_BYTES), coldAt)

    const replay = materializeTerminalReplay(session)
    assert.equal(replay.length, TERMINAL_STANDARD_REPLAY_BYTES)
    assert.equal(session.output.retainedBytes, TERMINAL_STANDARD_REPLAY_BYTES)
    assert.equal(replay, 'x'.repeat(TERMINAL_STANDARD_REPLAY_BYTES))
  }

  // A replay whose head was cut must not start inside an escape sequence.
  //
  // THE DEFECT: chunks are pty read boundaries, so evicting the oldest ones to
  // stay inside the byte budget routinely leaves the window starting mid-sequence.
  // xterm has no introducer to match and prints the rest as text, so switching
  // back to a busy chat painted `38;2;139;139;140;48;2;34;34;37m` across the top
  // of an otherwise black screen (observed 2026-09-12, a Codex chat).
  function assertCutReplayNeverStartsMidEscapeSequence(): void {
    const esc = String.fromCharCode(0x1b)

    // The unit: a dangling SGR tail, resynced to the sequence that follows it.
    assert.equal(
      resyncTerminalReplayHead(`8;2;34;34;37m painted${esc}[0m\r\nnext`),
      `${esc}[0m\r\nnext`,
      'the head starts at an ESC, which is where a terminal can start parsing',
    )
    assert.equal(
      resyncTerminalReplayHead('half a line\nwhole one\n'),
      'whole one\n',
      'a newline resyncs too — no CSI sequence spans one',
    )
    assert.equal(
      resyncTerminalReplayHead(`${esc}[0m already clean`),
      `${esc}[0m already clean`,
      'a head already at a sequence boundary is untouched',
    )
    assert.equal(
      resyncTerminalReplayHead('y'.repeat(9_000)),
      'y'.repeat(9_000),
      'no resync point inside the window: keep the scrollback rather than gut it',
    )

    // And end to end, through the eviction that causes it.
    const session = createSession({ startedAt: Date.now() })
    const paint = (line: number) => `${esc}[38;2;139;139;140;48;2;34;34;37m line ${line} of painted output${esc}[0m\r\n`
    let pending = ''
    for (let line = 0; line < 40_000; line += 1) {
      pending += paint(line)
      // 1361 bytes at a time: a pty read boundary, which falls wherever it falls.
      while (pending.length >= 1_361) {
        appendTerminalOutput(session, pending.slice(0, 1_361), Date.now())
        pending = pending.slice(1_361)
      }
    }

    assert.equal(session.output.truncated, true, 'the buffer really did evict')
    const replay = materializeTerminalReplay(session)
    assert.equal(replay.charCodeAt(0), 0x1b, 'the replay opens on an escape sequence, not the tail of one')
    assert.equal(
      /^[0-9;:]/.test(replay),
      false,
      'and never on the parameters of a sequence whose introducer was evicted',
    )
  }

  // The other half: a buffer nobody cut is the CLI's own first byte onwards, and
  // resyncing it would eat the banner every agent opens with.
  function assertUncutReplayIsHandedBackByteForByte(): void {
    const session = createSession({ startedAt: Date.now() })
    appendTerminalOutput(session, 'Welcome to the agent\nReady\n', Date.now())
    assert.equal(session.output.truncated, false, 'nothing was cut')
    assert.equal(
      materializeTerminalReplay(session),
      'Welcome to the agent\nReady\n',
      'an untouched buffer replays verbatim, first line included',
    )
  }

  function assertColdSessionNewOutputUsesRecentReplayTier(): void {
    const coldAt = Date.now() - TERMINAL_RECENT_HISTORY_WINDOW_MS - 1_000
    const session = createSession({ startedAt: coldAt })

    appendTerminalOutput(session, 'n'.repeat(TERMINAL_RECENT_REPLAY_BYTES), Date.now())

    assert.equal(getTerminalSnapshot(session).historyTier, 'recent')
    assert.equal(session.output.retainedBytes, TERMINAL_RECENT_REPLAY_BYTES)
  }

  function assertVisibilityRecordingUpdatesRecency(): void {
    const session = createSession({ startedAt: 100, visible: false })
    assert.equal(session.lastVisibleAt, null)

    recordTerminalVisibility(session, true, 500)
    assert.equal(session.visible, true)
    assert.equal(session.lastVisibleAt, 500)

    recordTerminalVisibility(session, false, 900)
    assert.equal(session.visible, false)
    assert.equal(
      session.lastVisibleAt,
      900,
      'hiding still records lastVisibleAt for the snapshot, even though it no longer feeds the idle clock',
    )

    const snapshot = getTerminalSnapshot(session)
    assert.equal(snapshot.lastVisibleAt, 900)
  }

  function assertStaleRuleExemptsVisibleSessionsWithLiveSender(): void {
    const startedAt = 1_000
    const wellPastStale = startedAt + STALE_TERMINAL_MAX_UNSEEN_MS * 2

    const visible = createSession({ startedAt, visible: true })
    assert.equal(isTerminalSessionStale(visible, wellPastStale), false)

    const visibleButWindowGone = createSession({ startedAt, visible: true, senderDestroyed: true })
    assert.equal(isTerminalSessionStale(visibleButWindowGone, wellPastStale), true)

    const hidden = createSession({ startedAt, visible: false })
    assert.equal(isTerminalSessionStale(hidden, wellPastStale), true)

    const disposed = createSession({ startedAt, visible: false })
    disposed.isDisposed = true
    assert.equal(isTerminalSessionStale(disposed, wellPastStale), false, 'disposed sessions are already gone')
  }

  function assertStaleRuleUsesMostRecentUserSignal(): void {
    const startedAt = 1_000
    const session = createSession({ startedAt, visible: false })
    session.lastOutputAt = startedAt

    recordTerminalInput(session, 5_000)
    appendTerminalOutput(session, 'output', 9_000)
    // Becoming visible/hidden must NOT extend the idle clock — only real input and
    // output count, so merely looking at a terminal can never keep it alive.
    recordTerminalVisibility(session, false, 12_000)
    assert.equal(
      getTerminalLastSeenAt(session),
      9_000,
      'visibility does not count toward last-seen; the last real output (9_000) wins over the later visibility timestamp (12_000)',
    )

    assert.equal(isTerminalSessionStale(session, 9_000 + STALE_TERMINAL_MAX_UNSEEN_MS), false)
    assert.equal(isTerminalSessionStale(session, 9_000 + STALE_TERMINAL_MAX_UNSEEN_MS + 1), true)
  }

  // `visible` means painted now: a minimized or locked window reports its panes
  // hidden. A terminal that sat on screen for days with no output must not be
  // disposed the moment its window is minimized. The backstop counts from when
  // it was last on screen, and a hide repeated while hidden is not a look.
  function assertStaleRuleCountsFromTheLastMomentOnScreen(): void {
    const startedAt = 1_000
    const session = createSession({ startedAt, visible: false })
    recordTerminalVisibility(session, true, 2_000)
    const minimizedAt = startedAt + STALE_TERMINAL_MAX_UNSEEN_MS * 3
    recordTerminalVisibility(session, false, minimizedAt)
    assert.equal(
      isTerminalSessionStale(session, minimizedAt + 60_000),
      false,
      'on screen until a minute ago: not stale, however old its last output',
    )
    assert.equal(isTerminalSessionStale(session, minimizedAt + STALE_TERMINAL_MAX_UNSEEN_MS + 1), true)

    // Hidden, and told so again later (a window re-reporting its panes): the
    // repeat is not time on screen.
    recordTerminalVisibility(session, false, minimizedAt + STALE_TERMINAL_MAX_UNSEEN_MS)
    assert.equal(isTerminalSessionStale(session, minimizedAt + STALE_TERMINAL_MAX_UNSEEN_MS + 1), true)

    // A settled agent is never reaped by the backstop, however long unseen:
    // disposing it deletes the sidecar that is the only copy of its history.
    const longAfter = minimizedAt + STALE_TERMINAL_MAX_UNSEEN_MS * 10
    const paused = createSession({ startedAt, visible: false })
    paused.suspended = true
    assert.equal(isTerminalSessionStale(paused, longAfter), false, 'a paused agent keeps its history')
    const finished = createSession({ startedAt, visible: false })
    finished.hasExited = true
    assert.equal(isTerminalSessionStale(finished, longAfter), false, 'so does a finished one')
  }

  // Freeze-the-view: a suspended session's pty is killed, so it reports not-alive
  // (un-bolds, drops out of resident memory, is not re-reaped) while staying a
  // resumable, painted session — distinct from exited/disposed.
  function assertSuspendedSessionIsNotAlive(): void {
    const session = createSession({ startedAt: 1_000 })
    assert.equal(isTerminalProcessAlive(session), true)
    assert.equal(getTerminalSnapshot(session).suspended, false)

    session.suspended = true
    assert.equal(
      isTerminalProcessAlive(session),
      false,
      'a suspended session is not alive even though it has not exited or been disposed',
    )
    assert.equal(getTerminalSnapshot(session).suspended, true)
  }

  function createSession(input: {
    startedAt: number
    idleTimer?: ReturnType<typeof setTimeout>
    visible?: boolean
    senderDestroyed?: boolean
  }): TerminalSession {
    const visible = input.visible ?? true
    return {
      sessionId: 'session_1',
      process: {
        write: () => undefined,
        resize: () => undefined,
        kill: () => undefined,
        onData: () => ({ dispose: () => undefined }),
        onExit: () => ({ dispose: () => undefined }),
      } as unknown as TerminalSession['process'],
      sender: {
        isDestroyed: () => input.senderDestroyed ?? false,
      } as TerminalSession['sender'],
      isReady: true,
      hasExited: false,
      exitedAt: null,
      isDisposed: false,
      idleTimer: input.idleTimer,
      activity: createInitialTerminalActivity(input.startedAt),
      output: new TerminalReplayBuffer(),
      kind: 'agent',
      workspaceId: 'workspace_1',
      agentId: 'developer-1',
      visible,
      startedAt: input.startedAt,
      lastOutputAt: input.startedAt,
      lastInputAt: null,
      lastVisibleAt: visible ? input.startedAt : null,
    }
  }
})
