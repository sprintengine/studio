import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import type { PluginAgentStateSpec } from '../shared/plugin-manifest'
import {
  AGENT_STATE_HOOK_TAG,
  buildAgentStateReporterCommand,
  deriveActivityFromPhase,
  evaluateAgentStall,
  installAgentStateReporter,
  isAtRestAgentPhase,
  MAX_TRANSCRIPT_PATH_LENGTH,
  MAX_WAKEUP_DELAY_SECONDS,
  mergeAgentStateHooks,
  mergeTomlAgentStateHooks,
  mergeTomlArrayAgentStateHooks,
  parseAgentStateFrame,
  registeredAgentStateEvents,
  renderAgentStatePluginTemplate,
  renderOwnedJsonAgentStateHooksConfig,
  renderTomlAgentStateHooksBlock,
  renderTomlArrayAgentStateHooksBlock,
  unmergeTomlAgentStateHooks,
  resolveAgentStateEvent,
  selectAgentStateTarget,
  uninstallAgentStateReporter,
} from './agent-state'

type Settings = {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ type: string; command: string; _multicode?: string }> }>>
}

async function readSettings(path: string): Promise<Settings> {
  return JSON.parse(await readFile(path, 'utf8')) as Settings
}

function countOurEntries(settings: Settings): number {
  let n = 0
  for (const blocks of Object.values(settings.hooks ?? {})) {
    for (const block of blocks) {
      for (const entry of block.hooks ?? []) {
        if (entry._multicode === AGENT_STATE_HOOK_TAG) n += 1
      }
    }
  }
  return n
}

// The mapping data under test is the REAL bundled manifest data — the manifests
// are the single source of truth for each CLI's vocabulary now, so the fixtures
// must be the shipped files, not hand-copied tables that could drift.
async function loadBundledSpec(pluginId: string): Promise<PluginAgentStateSpec> {
  const manifestPath = join(process.cwd(), 'resources', 'plugins', pluginId, 'plugin.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { agentStateSpec?: PluginAgentStateSpec }
  assert.ok(manifest.agentStateSpec, `${pluginId} manifest must declare agentStateSpec`)
  return manifest.agentStateSpec
}

// Run the bundled reporter for real: pipe a CLI hook payload into it over stdin
// and capture the frame it writes to the agent-state socket. Resolves to null if
// the reporter dropped the payload (no frame).
async function runReporter(event: string): Promise<Record<string, unknown> | null> {
  // The reporter always exits 0 and stays silent on failure, so a wrong path
  // would read as "no frame" — i.e. as a drop assertion passing for the wrong
  // reason. Fail loudly instead.
  const reporterPath = join(process.cwd(), 'resources', 'hooks', 'multicode-agent-state.mjs')
  assert.ok(existsSync(reporterPath), `reporter script not found at ${reporterPath}`)
  const dir = await mkdtemp(join(tmpdir(), 'agent-state-reporter-'))
  const socketPath = join(dir, 'sock')
  const received: string[] = []
  const server = createServer((socket) => {
    socket.on('data', (chunk) => received.push(chunk.toString('utf8')))
  })
  await new Promise<void>((res) => server.listen(socketPath, res))
  try {
    const child = spawn(process.execPath, [reporterPath, '--socket', socketPath], {
      // MULTICODE_AGENT_STATE_SOCKET is pinned, not just --socket: the reporter
      // reads env FIRST, so when this suite runs inside a Multicode agent
      // terminal the inherited value would send the frame to the live app.
      env: {
        ...process.env,
        MULTICODE_AGENT_STATE_SOCKET: socketPath,
        MULTICODE_AGENT_ID: 'agent-1',
        MULTICODE_WORKSPACE_ID: 'ws-1',
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    // Every real payload for these events carries a transcript_path; forwarding
    // it is what the reporter must gate on the event, not on the field.
    child.stdin.end(
      JSON.stringify({ hook_event_name: event, session_id: 's1', transcript_path: '/tmp/session.jsonl', notification_type: 'permission_prompt' })
    )
    await new Promise<void>((res) => child.on('close', () => res()))
    const line = received.join('').trim()
    return line ? (JSON.parse(line) as Record<string, unknown>) : null
  } finally {
    await new Promise<void>((res) => server.close(() => res()))
  }
}

async function run(): Promise<void> {
  const claudeSpec = await loadBundledSpec('claude-code')
  const codexSpec = await loadBundledSpec('codex')
  const grokSpec = await loadBundledSpec('grok')
  const opencodeSpec = await loadBundledSpec('opencode')

  // zai and kimi-claude run the same `claude` binary; their operative spec
  // (registration + events; $comment aside) must stay identical to claude-code
  // so the shared settings file carries one consistent registration.
  const operative = (spec: PluginAgentStateSpec) => ({ registration: spec.registration, events: spec.events })
  assert.deepEqual(operative(await loadBundledSpec('zai')), operative(claudeSpec))
  assert.deepEqual(operative(await loadBundledSpec('kimi-claude')), operative(claudeSpec))

  const resolvePhase = (spec: PluginAgentStateSpec, event: string, notificationType?: string) => {
    const resolution = resolveAgentStateEvent(spec, { event, notificationType })
    return resolution.action === 'apply' ? resolution.phase : null
  }

  // --- event → phase mapping (manifest-driven) ----------------------------
  assert.equal(resolvePhase(claudeSpec, 'SessionStart'), 'starting')
  assert.equal(resolvePhase(claudeSpec, 'UserPromptSubmit'), 'thinking')
  assert.equal(resolvePhase(claudeSpec, 'PreToolUse'), 'tool_use')
  assert.equal(resolvePhase(claudeSpec, 'PostToolUse'), 'thinking')
  assert.equal(resolvePhase(claudeSpec, 'Stop'), 'idle')
  assert.equal(resolvePhase(claudeSpec, 'SubagentStop'), 'idle')
  assert.equal(resolvePhase(claudeSpec, 'SessionEnd'), 'exited')
  assert.equal(resolvePhase(claudeSpec, 'NotAnEvent'), null)
  assert.equal(resolvePhase(codexSpec, 'PermissionRequest'), 'awaiting_input')
  // Codex has no SessionEnd (pty exit owns real exits) and no Notification.
  assert.equal(resolvePhase(codexSpec, 'SessionEnd'), null)
  assert.equal(resolvePhase(codexSpec, 'Notification', 'permission_prompt'), null)

  // --- Notification notification_type discrimination ----------------------
  // Only ALLOW-LISTED blocking types report awaiting_input. awaiting_input is
  // sticky for a dormant agent (no later frame clears it), so an unknown or
  // absent type must DROP — promoting it parked sessions as falsely
  // "needs input" and exempted them from the idle reaper forever (2026-07-07).
  assert.equal(resolvePhase(claudeSpec, 'Notification', 'permission_prompt'), 'awaiting_input')
  assert.equal(resolvePhase(claudeSpec, 'Notification', 'elicitation_dialog'), 'awaiting_input')
  assert.equal(resolvePhase(claudeSpec, 'Notification', 'agent_needs_input'), 'awaiting_input')
  // Informational types drop.
  assert.equal(resolvePhase(claudeSpec, 'Notification', 'idle_prompt'), null)
  assert.equal(resolvePhase(claudeSpec, 'Notification', 'auth_success'), null)
  assert.equal(resolvePhase(claudeSpec, 'Notification', 'elicitation_complete'), null)
  assert.equal(resolvePhase(claudeSpec, 'Notification', 'elicitation_response'), null)
  assert.equal(resolvePhase(claudeSpec, 'Notification', 'agent_completed'), null)
  // Unknown and untyped notifications drop too — the sticky-phase trap.
  assert.equal(resolvePhase(claudeSpec, 'Notification', 'some_future_type'), null)
  assert.equal(resolvePhase(claudeSpec, 'Notification'), null)
  // The discriminator is only consulted where declared.
  assert.equal(resolvePhase(codexSpec, 'PermissionRequest', 'idle_prompt'), 'awaiting_input')
  // Grok registers Claude's Notification with the same allow-list.
  assert.equal(resolvePhase(grokSpec, 'Notification', 'permission_prompt'), 'awaiting_input')
  assert.equal(resolvePhase(grokSpec, 'Notification', 'idle_prompt'), null)

  // --- stale-reporter compatibility on discriminated events ----------------
  // A reporter copy from before the dumb-forwarder change filtered Notification
  // CLIENT-side: it sent {phase: 'awaiting_input', event: 'Notification'} with
  // no notificationType field at all. Until the next successful install
  // replaces it, its own filtering is honored — but ONLY when the asserted
  // phase matches the entry's mapped phase; anything else stays dropped.
  assert.deepEqual(
    resolveAgentStateEvent(claudeSpec, { event: 'Notification', phase: 'awaiting_input' }),
    { action: 'apply', phase: 'awaiting_input', turnEnd: false, turnFailure: false },
    'a stale reporter’s pre-filtered Notification must still light awaiting_input'
  )
  // A dumb-forwarder frame (no phase) with an untyped Notification still drops.
  assert.deepEqual(resolveAgentStateEvent(claudeSpec, { event: 'Notification' }), { action: 'drop' })
  // A mismatched asserted phase does not ride the compat path.
  assert.deepEqual(resolveAgentStateEvent(claudeSpec, { event: 'Notification', phase: 'idle' }), { action: 'drop' })
  // A PRESENT-but-unlisted discriminator drops even when the phase matches:
  // the new reporter forwarded the type and the allow-list rejected it.
  assert.deepEqual(
    resolveAgentStateEvent(claudeSpec, { event: 'Notification', phase: 'awaiting_input', notificationType: 'idle_prompt' }),
    { action: 'drop' }
  )

  // --- fallback for spec-less frames --------------------------------------
  // No spec (a CLI outside the manifest capability whose reporter still emits
  // frames): the reporter-asserted phase is trusted, with no turn semantics.
  assert.deepEqual(resolveAgentStateEvent(null, { event: 'Whatever', phase: 'thinking' }), {
    action: 'apply',
    phase: 'thinking',
    turnEnd: false,
    turnFailure: false,
  })
  assert.deepEqual(resolveAgentStateEvent(null, { event: 'Whatever' }), { action: 'drop' })
  // With a spec, an unknown event drops even when the frame asserts a phase —
  // the manifest owns this CLI's vocabulary.
  assert.deepEqual(resolveAgentStateEvent(claudeSpec, { event: 'NotAnEvent', phase: 'thinking' }), { action: 'drop' })
  // An event-less legacy frame with a phase still applies.
  assert.equal(resolveAgentStateEvent(claudeSpec, { event: null, phase: 'idle' }).action, 'apply')

  // --- turn-end / turn-failure flags (manifest-declared) -------------------
  // SubagentStop maps to the same `idle` phase as Stop but is a subagent
  // finishing, and session.error also maps to `idle` but is a crash — either
  // one read as a turn end finalizes work that isn't done.
  const flags = (spec: PluginAgentStateSpec, event: string) => {
    const r = resolveAgentStateEvent(spec, { event, notificationType: undefined })
    return r.action === 'apply' ? { turnEnd: r.turnEnd, turnFailure: r.turnFailure } : null
  }
  assert.deepEqual(flags(claudeSpec, 'Stop'), { turnEnd: true, turnFailure: false })
  assert.deepEqual(flags(claudeSpec, 'SubagentStop'), { turnEnd: false, turnFailure: false })
  assert.deepEqual(flags(codexSpec, 'Stop'), { turnEnd: true, turnFailure: false })
  assert.deepEqual(flags(opencodeSpec, 'session.idle'), { turnEnd: true, turnFailure: false })
  assert.deepEqual(flags(opencodeSpec, 'session.error'), { turnEnd: false, turnFailure: true })
  // Both turn ends land on `idle` — which is exactly why the flag exists.
  assert.equal(resolvePhase(opencodeSpec, 'session.error'), resolvePhase(opencodeSpec, 'session.idle'))

  // --- OpenCode mapping (manifest-driven) ----------------------------------
  assert.equal(resolvePhase(opencodeSpec, 'session.created'), 'starting')
  assert.equal(resolvePhase(opencodeSpec, 'message.updated'), 'thinking')
  assert.equal(resolvePhase(opencodeSpec, 'permission.updated'), 'awaiting_input')
  // The load-bearing transition: answering a prompt clears awaiting_input.
  assert.equal(resolvePhase(opencodeSpec, 'permission.replied'), 'thinking')
  assert.equal(resolvePhase(opencodeSpec, 'tool.execute.before'), 'tool_use')
  assert.equal(resolvePhase(opencodeSpec, 'tool.execute.after'), 'thinking')
  // No event synthesizes an exit (pty exit listener owns that), and unknown
  // events are dropped rather than guessed.
  assert.equal(resolvePhase(opencodeSpec, 'session.deleted'), null)
  assert.equal(resolvePhase(opencodeSpec, 'file.edited'), null)

  // --- registered event subsets --------------------------------------------
  // PreToolUse is declared map-only (register: false): it must be mapped when a
  // stale registration fires it, but never registered anew.
  const claudeRegistered = registeredAgentStateEvents(claudeSpec)
  assert.ok(!claudeRegistered.some((e) => e.event === 'PreToolUse'), 'PreToolUse must not be registered')
  assert.ok(claudeRegistered.some((e) => e.event === 'PostToolUse' && e.matcher === '*'), 'PostToolUse * missing')
  assert.equal(claudeRegistered.length, claudeSpec.events.length - 1)
  const codexRegistered = registeredAgentStateEvents(codexSpec)
  assert.ok(!codexRegistered.some((e) => e.event === 'PreToolUse'))
  assert.ok(codexRegistered.some((e) => e.event === 'PermissionRequest'))

  // --- phase → activity bridge -------------------------------------------
  assert.deepEqual(deriveActivityFromPhase('thinking', 5), { kind: 'working', since: 5 })
  assert.deepEqual(deriveActivityFromPhase('tool_use', 5), { kind: 'working', since: 5 })
  assert.deepEqual(deriveActivityFromPhase('starting', 5), { kind: 'working', since: 5 })
  assert.deepEqual(deriveActivityFromPhase('awaiting_input', 7), { kind: 'idle', since: 7 })
  assert.deepEqual(deriveActivityFromPhase('idle', 7), { kind: 'idle', since: 7 })
  assert.deepEqual(deriveActivityFromPhase('stalled', 7), { kind: 'idle', since: 7 })
  // Terminal phases never synthesize an activity — the pty exit owns that.
  assert.equal(deriveActivityFromPhase('exited', 7), null)
  assert.equal(deriveActivityFromPhase('failed', 7), null)

  // --- untrusted frame validation ----------------------------------------
  const valid = parseAgentStateFrame(
    { type: 'agent_state', agentId: 'a1', workspaceId: 'w1', sessionId: 's1', phase: 'tool_use', event: 'PreToolUse', ts: 123 },
    999
  )
  assert.deepEqual(valid, {
    type: 'agent_state',
    agentId: 'a1',
    workspaceId: 'w1',
    sessionId: 's1',
    phase: 'tool_use',
    event: 'PreToolUse',
    ts: 123,
  })
  // A phase-less frame (the dumb-forwarder reporter) is valid with an event…
  const forwarded = parseAgentStateFrame(
    { type: 'agent_state', agentId: 'a1', event: 'Notification', notificationType: 'permission_prompt', ts: 5 },
    999
  )
  assert.equal(forwarded?.phase, undefined)
  assert.equal(forwarded?.event, 'Notification')
  assert.equal(forwarded?.notificationType, 'permission_prompt')
  // …an oversized discriminator value drops the field, not the frame…
  assert.equal(
    parseAgentStateFrame(
      { type: 'agent_state', agentId: 'a1', event: 'Notification', notificationType: 'x'.repeat(500), ts: 5 },
      999
    )?.notificationType,
    undefined
  )
  // …the status discriminator rides the same validation (capped, optional)…
  assert.equal(
    parseAgentStateFrame({ type: 'agent_state', agentId: 'a1', event: 'stop', status: 'error', ts: 5 }, 999)?.status,
    'error'
  )
  assert.equal(
    parseAgentStateFrame({ type: 'agent_state', agentId: 'a1', event: 'stop', status: 'x'.repeat(500), ts: 5 }, 999)?.status,
    undefined
  )
  // …and a frame with neither event nor a valid phase carries nothing to apply.
  assert.equal(parseAgentStateFrame({ type: 'agent_state', agentId: 'a1', ts: 5 }, 999), null)
  assert.equal(parseAgentStateFrame({ type: 'agent_state', agentId: 'a1', phase: 'nope' }, 1), null)
  // ts defaults to `now` when absent or non-finite.
  assert.equal(parseAgentStateFrame({ type: 'agent_state', agentId: 'a1', phase: 'idle' }, 999)?.ts, 999)
  // rejects: wrong type, missing agentId, non-object.
  assert.equal(parseAgentStateFrame({ type: 'other', agentId: 'a1', phase: 'idle' }, 1), null)
  assert.equal(parseAgentStateFrame({ type: 'agent_state', phase: 'idle' }, 1), null)
  assert.equal(parseAgentStateFrame('not-json-object', 1), null)
  assert.equal(parseAgentStateFrame(null, 1), null)

  // --- self-scheduled wakeup (ScheduleWakeup PostToolUse frame) -----------
  const base = { type: 'agent_state', agentId: 'a1', phase: 'thinking', event: 'PostToolUse', ts: 123 }
  // A schedule and a stop both survive validation…
  assert.deepEqual(parseAgentStateFrame({ ...base, wakeup: { delaySeconds: 1200 } }, 999)?.wakeup, { delaySeconds: 1200 })
  assert.deepEqual(parseAgentStateFrame({ ...base, wakeup: { stop: true } }, 999)?.wakeup, { stop: true })
  // …an implausible delay is clamped (one bad frame must not park a session)…
  assert.deepEqual(
    parseAgentStateFrame({ ...base, wakeup: { delaySeconds: 10 * MAX_WAKEUP_DELAY_SECONDS } }, 999)?.wakeup,
    { delaySeconds: MAX_WAKEUP_DELAY_SECONDS }
  )
  // …and a malformed wakeup drops while the frame itself stands.
  for (const bad of [{ delaySeconds: -5 }, { delaySeconds: 'soon' }, { stop: false }, 'junk', 42, {}]) {
    const frame = parseAgentStateFrame({ ...base, wakeup: bad }, 999)
    assert.ok(frame, `frame must survive malformed wakeup: ${JSON.stringify(bad)}`)
    assert.equal(frame?.wakeup, undefined, `malformed wakeup must drop: ${JSON.stringify(bad)}`)
  }

  // --- transcript path (untrusted, optional, field-level drop) ------------
  // A valid path rides the frame…
  assert.equal(
    parseAgentStateFrame({ ...base, event: 'Stop', phase: 'idle', transcriptPath: '/tmp/t.jsonl' }, 999)?.transcriptPath,
    '/tmp/t.jsonl'
  )
  // …and every invalid value drops ONLY the field: losing a summary is a
  // degradation, losing the frame would lose the turn end itself.
  for (const bad of [undefined, null, '', 42, {}, ['/tmp/t.jsonl'], 'x'.repeat(MAX_TRANSCRIPT_PATH_LENGTH + 1)]) {
    const frame = parseAgentStateFrame({ ...base, event: 'Stop', phase: 'idle', transcriptPath: bad }, 999)
    assert.ok(frame, `frame must survive bad transcriptPath: ${JSON.stringify(bad)}`)
    assert.equal(frame?.transcriptPath, undefined, `bad transcriptPath must drop: ${JSON.stringify(bad)}`)
  }

  // --- reporter forwards raw events, transcript_path on Stop ONLY ---------
  // Driven as a real subprocess against a real socket: the reporter is the only
  // producer of transcriptPath, and SubagentStop carries a transcript_path of
  // its own that must never be forwarded. The reporter asserts NO phase — the
  // manifest mapping in main owns that — and forwards the discriminator field.
  {
    const stopFrame = await runReporter('Stop')
    assert.equal(stopFrame?.phase, undefined, 'the reporter must not assert a phase')
    assert.equal(stopFrame?.event, 'Stop')
    assert.equal(stopFrame?.transcriptPath, '/tmp/session.jsonl', 'Stop must forward transcript_path')

    const subagentFrame = await runReporter('SubagentStop')
    assert.equal(subagentFrame?.event, 'SubagentStop', 'SubagentStop still reports its event')
    assert.equal(subagentFrame?.transcriptPath, undefined, 'SubagentStop must NOT forward transcript_path')

    const toolFrame = await runReporter('PostToolUse')
    assert.equal(toolFrame?.transcriptPath, undefined, 'only a turn end forwards transcript_path')

    const notificationFrame = await runReporter('Notification')
    assert.equal(notificationFrame?.notificationType, 'permission_prompt', 'Notification must forward notification_type')

    // Even an event outside every manifest is forwarded — filtering is main's
    // job (the spec drops unknown events), not the reporter's.
    const unknownFrame = await runReporter('SomeFutureEvent')
    assert.equal(unknownFrame?.event, 'SomeFutureEvent')
  }

  // --- future-dated ts is clamped to server arrival (phase-freeze bug) ----
  // A reporter cannot legitimately be ahead of the main-process clock. Without
  // the clamp a single far-future frame pins agentState.since in the future and
  // terminal-runtime's stale-frame guard (since > frame.ts) then drops every
  // later frame forever, future-dating the user-visible "working since".
  {
    const arrival = 1_000_000
    const future = parseAgentStateFrame(
      { type: 'agent_state', agentId: 'a1', phase: 'thinking', ts: arrival + 5_000_000 },
      arrival
    )
    // ts is capped at `now`, never the future raw value.
    assert.equal(future?.ts, arrival, 'future ts is clamped to now')
    assert.ok(future!.ts <= arrival, 'clamped since is not future-dated')

    // A normal frame arriving just after still parses, and terminal-runtime's
    // drop guard (recorded since > frame.ts) does NOT drop it, because the
    // future frame recorded since=arrival rather than the future raw value.
    const normal = parseAgentStateFrame(
      { type: 'agent_state', agentId: 'a1', phase: 'idle', ts: arrival + 1 },
      arrival + 1
    )
    assert.ok(normal, 'normal frame parses')
    const recordedSince = future!.ts
    const droppedByStaleGuard = recordedSince > normal!.ts
    assert.equal(droppedByStaleGuard, false, 'normal frame is not dropped after a future-dated frame')
  }

  // --- frame → session resolution ----------------------------------------
  type Sess = { id: string; agentId?: string; executionId?: string; sessionId?: string; workspaceId?: string; startedAt: number }
  const cand = (s: Sess) => ({ value: s, agentId: s.agentId, executionId: s.executionId, sessionId: s.sessionId, workspaceId: s.workspaceId, startedAt: s.startedAt })
  // No match → undefined.
  assert.equal(selectAgentStateTarget([cand({ id: 'x', agentId: 'a', startedAt: 1 })], { agentId: 'zzz', workspaceId: null }), undefined)
  // Match by agentId.
  assert.equal(
    selectAgentStateTarget([cand({ id: 'x', agentId: 'a', startedAt: 1 })], { agentId: 'a', workspaceId: null })?.id,
    'x'
  )
  // Match by executionId and by sessionId.
  assert.equal(
    selectAgentStateTarget([cand({ id: 'x', executionId: 'exec1', startedAt: 1 })], { agentId: 'exec1', workspaceId: null })?.id,
    'x'
  )
  assert.equal(
    selectAgentStateTarget([cand({ id: 'x', sessionId: 'sess1', startedAt: 1 })], { agentId: 'sess1', workspaceId: null })?.id,
    'x'
  )
  // Two live sessions share an agent id: workspace scoping wins.
  const dupA = cand({ id: 'old', agentId: 'a', workspaceId: 'w1', startedAt: 1 })
  const dupB = cand({ id: 'new', agentId: 'a', workspaceId: 'w2', startedAt: 2 })
  assert.equal(selectAgentStateTarget([dupA, dupB], { agentId: 'a', workspaceId: 'w1' })?.id, 'old')
  // No workspace on the frame → most recently started wins.
  assert.equal(selectAgentStateTarget([dupA, dupB], { agentId: 'a', workspaceId: null })?.id, 'new')
  // Workspace given but matches none → fall back to most recent across all.
  assert.equal(selectAgentStateTarget([dupA, dupB], { agentId: 'a', workspaceId: 'nope' })?.id, 'new')

  // --- stall evaluation ---------------------------------------------------
  const stallBase = { phaseSince: 0, lastOutputAt: null, now: 100_000, thresholdMs: 90_000 }
  // Non-working phases never stall, and inferred thinking/tool_use no longer
  // exist as inputs (output-timing inference was deleted) — cleared if seen.
  assert.deepEqual(evaluateAgentStall({ ...stallBase, phase: 'tool_use', source: 'inferred' }), { action: 'clear' })
  assert.deepEqual(evaluateAgentStall({ ...stallBase, phase: 'idle', source: 'hook' }), { action: 'clear' })
  assert.deepEqual(evaluateAgentStall({ ...stallBase, phase: 'awaiting_input', source: 'hook' }), { action: 'clear' })
  // Working + quiet past the threshold → stalled.
  assert.deepEqual(evaluateAgentStall({ ...stallBase, phase: 'tool_use', source: 'hook' }), { action: 'stalled' })
  assert.deepEqual(evaluateAgentStall({ ...stallBase, phase: 'thinking', source: 'hook' }), { action: 'stalled' })
  // 'starting' arms too: a resumed session that never receives a prompt has
  // SessionStart as its only frame (no Stop follows), so it must convert to
  // stalled — and then expire via the reap policy — instead of parking forever.
  assert.deepEqual(evaluateAgentStall({ ...stallBase, phase: 'starting', source: 'hook' }), { action: 'stalled' })
  // The INFERRED 'starting' every agent is lifecycle-stamped with at spawn
  // arms as well: a session whose hooks never fire (broken install — there is
  // no output-timing fallback any more) has no other path off "working".
  assert.deepEqual(evaluateAgentStall({ ...stallBase, phase: 'starting', source: 'inferred' }), { action: 'stalled' })
  assert.deepEqual(
    evaluateAgentStall({ phase: 'starting', source: 'hook', phaseSince: 80_000, lastOutputAt: null, now: 100_000, thresholdMs: 90_000 }),
    { action: 'recheck', afterMs: 70_000 }
  )
  // Recent output (streaming tool) keeps it alive — recheck after the remainder.
  assert.deepEqual(
    evaluateAgentStall({ phase: 'tool_use', source: 'hook', phaseSince: 0, lastOutputAt: 70_000, now: 100_000, thresholdMs: 90_000 }),
    { action: 'recheck', afterMs: 60_000 }
  )
  // A recent frame (phaseSince) likewise defers.
  assert.deepEqual(
    evaluateAgentStall({ phase: 'thinking', source: 'hook', phaseSince: 80_000, lastOutputAt: null, now: 100_000, thresholdMs: 90_000 }),
    { action: 'recheck', afterMs: 70_000 }
  )

  // --- at-rest vocabulary (reaper) ----------------------------------------
  // 'idle' and 'stalled' are the reapable rest states; everything else —
  // including null/undefined (no frame yet) — is not "at rest".
  assert.equal(isAtRestAgentPhase('idle'), true)
  assert.equal(isAtRestAgentPhase('stalled'), true)
  for (const phase of ['starting', 'thinking', 'tool_use', 'awaiting_input', 'exited', 'failed'] as const) {
    assert.equal(isAtRestAgentPhase(phase), false, `expected not at rest: ${phase}`)
  }
  assert.equal(isAtRestAgentPhase(null), false)
  assert.equal(isAtRestAgentPhase(undefined), false)

  // --- command builder ----------------------------------------------------
  // The reporter is referenced by its ABSOLUTE path (hook cwd is not guaranteed),
  // double-quoted so spaces survive and forward-slashed so a Windows `C:\...` path
  // carries no unescaped backslashes into the JSON/TOML command string.
  const cmd = buildAgentStateReporterCommand('/abs/multi code/.multicode/hooks/agent-state.mjs', '/tmp/multi code/agent.sock')
  assert.match(cmd, /^node "\/abs\/multi code\/\.multicode\/hooks\/agent-state\.mjs" --socket "\/tmp\/multi code\/agent\.sock"$/)
  // The host path separator is rewritten to '/': on Windows `resolve()` yields
  // backslashes, which Node accepts as forward slashes and which avoids embedding
  // unescaped backslashes. Build the input with the host `sep` so this holds on
  // any platform the test runs on.
  const sepCmd = buildAgentStateReporterCommand(['', 'abs', 'proj', 'agent-state.mjs'].join(sep), '/sock')
  assert.ok(sepCmd.includes('node "/abs/proj/agent-state.mjs"'), sepCmd)
  assert.ok(!sepCmd.slice(0, sepCmd.indexOf('--socket')).includes('\\'), 'script path must not contain backslashes')
  // A Windows named-pipe SOCKET path must survive verbatim — a separator rewrite
  // would corrupt `\\.\pipe\...` into `//./pipe/...`, which connect() cannot open.
  const winCmd = buildAgentStateReporterCommand('/abs/.multicode/hooks/agent-state.mjs', '\\\\.\\pipe\\multicode-agent-state-abc')
  assert.ok(winCmd.includes('--socket "\\\\.\\pipe\\multicode-agent-state-abc"'), winCmd)

  // --- settings-json install / uninstall round-trip (claude spec) ---------
  const root = await mkdtemp(join(tmpdir(), 'multicode-agent-state-'))
  const sourceScriptPath = join(root, 'reporter-src.mjs')
  await writeFile(sourceScriptPath, '// reporter\n', 'utf8')

  // A pre-existing user hook that must survive install + uninstall untouched.
  const settingsPath = join(root, '.claude', 'settings.local.json')
  await mkdir(join(root, '.claude'), { recursive: true })
  await writeFile(
    settingsPath,
    JSON.stringify({ hooks: {
      // The user's own hook — must survive install + uninstall untouched.
      PostToolUse: [
        { matcher: 'Read', hooks: [{ type: 'command', command: 'echo user' }] },
        // An untagged stale reporter: an external writer (e.g. Claude Code
        // rewriting settings.local.json) stripped the `_multicode` tag, then the
        // workspace root moved so the absolute path dangles. Install must claim
        // it by command shape and migrate it away, not strand it.
        { matcher: '*', hooks: [{ type: 'command', command: 'node "/old/root/.multicode/hooks/agent-state.mjs" --socket "/old/agent.sock"' }] },
      ],
      // A stale Multicode-tagged hook from a prior release that registered the
      // now-dropped PreToolUse event. Install must migrate it away (and uninstall
      // must also clean it), not strand it.
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'old reporter', _multicode: AGENT_STATE_HOOK_TAG }] }],
    } }, null, 2),
    'utf8'
  )

  const installed = await installAgentStateReporter(root, claudeSpec, { sourceScriptPath, socketPath: join(root, 'agent.sock') })
  assert.equal(installed.ok, true)

  const claudeRegisteredEvents = registeredAgentStateEvents(claudeSpec)
  let settings = await readSettings(settingsPath)
  // One entry per registered event.
  assert.equal(countOurEntries(settings), claudeRegisteredEvents.length)
  // Every registered event key is present.
  for (const { event } of claudeRegisteredEvents) {
    assert.ok(Array.isArray(settings.hooks?.[event]), `missing event ${event}`)
  }
  // PreToolUse is register:false; PostToolUse is kept (it clears awaiting_input).
  // So we add our own PostToolUse '*' block ALONGSIDE the user's 'Read' block
  // (2 blocks total), and never register PreToolUse.
  assert.equal(settings.hooks?.PreToolUse, undefined, 'PreToolUse must not be registered')
  assert.equal(settings.hooks?.PostToolUse?.length, 2, 'our PostToolUse block must coexist with the user block')
  assert.ok(settings.hooks?.PostToolUse?.some((b) => b.matcher === '*'), 'our PostToolUse * block is missing')
  const userEntry = settings.hooks?.PostToolUse?.find((b) => b.matcher === 'Read')
  assert.ok(userEntry, 'user PostToolUse block dropped')
  assert.equal(userEntry?.hooks?.[0]?.command, 'echo user')
  // The untagged stale reporter is claimed by command shape and replaced — its
  // dead absolute path must not survive install (nor duplicate our '*' entry).
  const postToolCommands = (settings.hooks?.PostToolUse ?? []).flatMap((b) => (b.hooks ?? []).map((h) => h.command))
  assert.ok(!postToolCommands.some((c) => c.includes('/old/root/')), 'untagged stale reporter survived install')
  const starBlock = settings.hooks?.PostToolUse?.find((b) => b.matcher === '*')
  assert.equal(starBlock?.hooks?.length, 1, 'expected exactly one reporter entry in the * block')

  // Our command references the reporter by ABSOLUTE path (the copied destination),
  // not a workspace-relative path: hook cwd is not guaranteed, so a relative path
  // would misresolve once the session cwd drifts off the root.
  const ourEntry = settings.hooks?.SessionStart?.[0]?.hooks?.find((h) => h._multicode === AGENT_STATE_HOOK_TAG)
  const expectedScript = join(root, '.multicode', 'hooks', 'agent-state.mjs').split('\\').join('/')
  assert.ok(ourEntry?.command.includes(`node "${expectedScript}"`), ourEntry?.command)
  // Guard against regressing to the relative form `node ".multicode/...`: in the
  // absolute form the opening quote is followed by the root (`/` or `C:/`), never
  // by `.multicode`, so this substring can only appear if a relative path leaked.
  assert.ok(!ourEntry?.command.includes('node ".multicode'), 'must not embed a relative script path')

  // Idempotent: installing again does not duplicate entries.
  await mergeAgentStateHooks(
    settingsPath,
    buildAgentStateReporterCommand(join(root, '.multicode', 'hooks', 'agent-state.mjs'), join(root, 'agent.sock')),
    claudeRegisteredEvents
  )
  settings = await readSettings(settingsPath)
  assert.equal(countOurEntries(settings), claudeRegisteredEvents.length)

  // Uninstall removes ours, keeps the user's, prunes emptied event keys.
  const removed = await uninstallAgentStateReporter(root, claudeSpec)
  assert.equal(removed.ok, true)
  settings = await readSettings(settingsPath)
  assert.equal(countOurEntries(settings), 0)
  assert.ok(settings.hooks?.PostToolUse?.some((b) => b.matcher === 'Read'), 'user hook lost on uninstall')
  // SessionStart had only our entry, so the event key is pruned entirely.
  assert.equal(settings.hooks?.SessionStart, undefined)

  // --- toml-block install (codex spec) ------------------------------------
  // Render: a single tagged block, one entry per registered Codex event,
  // command quoted as a TOML basic string, PostToolUse carrying a matcher, and
  // PermissionRequest (Codex's awaiting-input event) present rather than
  // Claude's Notification. PreToolUse is register:false, so its table is absent.
  const codexBlock = renderTomlAgentStateHooksBlock('node "/abs/agent-state.mjs" --socket "/abs/agent-state.sock"', codexRegistered)
  assert.ok(codexBlock.startsWith('# >>> multicode agent-state hooks managed'))
  assert.ok(codexBlock.trimEnd().endsWith('# <<< multicode agent-state hooks managed'))
  assert.ok(codexBlock.includes('[[hooks.PermissionRequest]]'))
  assert.ok(codexBlock.includes('[[hooks.Stop]]'))
  assert.ok(codexBlock.includes('[[hooks.PostToolUse]]') && codexBlock.includes('matcher = "*"'))
  assert.ok(!codexBlock.includes('[[hooks.PreToolUse]]'))
  assert.ok(!codexBlock.includes('Notification'))
  // command is a valid TOML basic string (JSON-escaped quotes).
  assert.ok(codexBlock.includes('command = "node \\"/abs/agent-state.mjs\\" --socket \\"/abs/agent-state.sock\\""'))
  // one [[hooks.<Event>]] table per registered event.
  const tableCount = (codexBlock.match(/^\[\[hooks\.[A-Za-z]+\]\]$/gmu) ?? []).length
  assert.equal(tableCount, codexRegistered.length)

  // Merge preserves surrounding user config and is idempotent.
  const userToml = 'model = "gpt-5-codex"\n\n[mcp_servers.foo]\ncommand = "foo"\n'
  const mergedOnce = mergeTomlAgentStateHooks(userToml, 'node "/x.mjs" --socket "/s.sock"', codexRegistered)
  assert.ok(mergedOnce.includes('model = "gpt-5-codex"'), 'user config dropped')
  assert.ok(mergedOnce.includes('[mcp_servers.foo]'), 'user MCP block dropped')
  const mergedTwice = mergeTomlAgentStateHooks(mergedOnce, 'node "/x.mjs" --socket "/s.sock"', codexRegistered)
  assert.equal(
    (mergedTwice.match(/# >>> multicode agent-state hooks managed/gu) ?? []).length,
    1,
    'agent-state block duplicated on re-merge'
  )

  // Install round-trip on disk: writes .codex/config.toml, copies the reporter,
  // preserves prior content, and uninstall removes the block but keeps the rest.
  const codexRoot = await mkdtemp(join(tmpdir(), 'multicode-agent-state-codex-'))
  const codexReporter = join(codexRoot, 'reporter-src.mjs')
  await writeFile(codexReporter, '// reporter\n', 'utf8')
  await mkdir(join(codexRoot, '.codex'), { recursive: true })
  await writeFile(join(codexRoot, '.codex', 'config.toml'), 'approval_policy = "on-request"\n', 'utf8')

  const codexInstalled = await installAgentStateReporter(codexRoot, codexSpec, {
    sourceScriptPath: codexReporter,
    socketPath: join(codexRoot, 'agent-state.sock'),
  })
  assert.equal(codexInstalled.ok, true)
  let codexConfig = await readFile(join(codexRoot, '.codex', 'config.toml'), 'utf8')
  assert.ok(codexConfig.includes('approval_policy = "on-request"'), 'prior codex config lost')
  assert.ok(codexConfig.includes('[[hooks.SessionStart]]'))
  // command references the reporter by ABSOLUTE path (Codex hooks have no cwd
  // guarantee) and the live socket.
  assert.ok(codexConfig.includes(join(codexRoot, '.multicode', 'hooks', 'agent-state.mjs').split('\\').join('/')))

  const codexRemoved = await uninstallAgentStateReporter(codexRoot, codexSpec)
  assert.equal(codexRemoved.ok, true)
  codexConfig = await readFile(join(codexRoot, '.codex', 'config.toml'), 'utf8')
  assert.ok(codexConfig.includes('approval_policy = "on-request"'), 'uninstall dropped user config')
  assert.ok(!codexConfig.includes('[[hooks.SessionStart]]'), 'uninstall left the hooks block')

  // --- plugin-file: socket baking renders a valid JS string literal --------
  const ocTemplate = "const BAKED_SOCKET = '__MULTICODE_AGENT_STATE_SOCKET__'\n"
  // A Windows pipe path's backslashes must survive as data, not act as escapes.
  const winSocket = '\\\\.\\pipe\\multicode-agent-state-abc'
  const renderedWin = renderAgentStatePluginTemplate(ocTemplate, winSocket)
  assert.ok(renderedWin.includes(`const BAKED_SOCKET = ${JSON.stringify(winSocket)}`), renderedWin)
  assert.ok(!renderedWin.includes("'__MULTICODE_AGENT_STATE_SOCKET__'"), 'token left unsubstituted')
  // The rendered literal round-trips back to the exact path.
  assert.equal(JSON.parse(renderedWin.split('= ')[1].trim()), winSocket)

  // --- plugin-file install round-trip on disk (opencode spec) --------------
  // Writes .opencode/plugin/multicode-agent-state.js with the socket baked in,
  // is idempotent, and uninstall removes the plugin file.
  const ocRoot = await mkdtemp(join(tmpdir(), 'multicode-agent-state-opencode-'))
  const ocReporter = join(ocRoot, 'opencode-reporter-src.mjs')
  await writeFile(ocReporter, ocTemplate, 'utf8')
  const ocSocket = join(ocRoot, 'agent-state.sock')

  const ocInstalled = await installAgentStateReporter(ocRoot, opencodeSpec, { sourceScriptPath: ocReporter, socketPath: ocSocket })
  assert.equal(ocInstalled.ok, true)
  const ocPluginPath = join(ocRoot, '.opencode', 'plugin', 'multicode-agent-state.js')
  let ocPlugin = await readFile(ocPluginPath, 'utf8')
  assert.ok(ocPlugin.includes(JSON.stringify(ocSocket)), 'opencode plugin missing baked socket')
  assert.ok(!ocPlugin.includes("'__MULTICODE_AGENT_STATE_SOCKET__'"), 'opencode socket token left unsubstituted')

  // Re-install is idempotent (overwrites in place, no second copy).
  const ocReinstall = await installAgentStateReporter(ocRoot, opencodeSpec, { sourceScriptPath: ocReporter, socketPath: ocSocket })
  assert.equal(ocReinstall.ok, true)
  ocPlugin = await readFile(ocPluginPath, 'utf8')
  assert.equal((ocPlugin.match(/const BAKED_SOCKET =/gu) ?? []).length, 1, 'opencode plugin duplicated on re-install')

  const ocRemoved = await uninstallAgentStateReporter(ocRoot, opencodeSpec)
  assert.equal(ocRemoved.ok, true)
  assert.equal(existsSync(ocPluginPath), false, 'uninstall left the opencode plugin file')

  // Missing source script is a safe, reported failure (never throws).
  const ocMissing = await installAgentStateReporter(ocRoot, opencodeSpec, {
    sourceScriptPath: join(ocRoot, 'nope.mjs'),
    socketPath: ocSocket,
  })
  assert.equal(ocMissing.ok, false)

  // --- owned-json: whole-file JSON hook config (grok spec) -----------------
  // Grok registers the same event set as Claude (shared reporter, camelCase
  // payload read by the same script), rendered as a standalone config file it
  // discovers from .grok/hooks/*.json — so the render is a full JSON document,
  // not a merge.
  const grokRegistered = registeredAgentStateEvents(grokSpec)
  const grokCommand = 'node "/abs/agent-state.mjs" --socket "/abs/agent-state.sock"'
  const grokConfig = JSON.parse(renderOwnedJsonAgentStateHooksConfig(grokCommand, grokRegistered)) as Settings
  assert.equal(Object.keys(grokConfig.hooks ?? {}).length, grokRegistered.length)
  for (const { event, matcher } of grokRegistered) {
    const blocks = grokConfig.hooks?.[event]
    assert.equal(blocks?.length, 1, `grok config missing event ${event}`)
    assert.equal(blocks?.[0]?.matcher, matcher, `grok ${event} matcher`)
    assert.deepEqual(blocks?.[0]?.hooks, [{ type: 'command', command: grokCommand }])
  }
  assert.equal(grokConfig.hooks?.PreToolUse, undefined, 'PreToolUse must not be registered for grok')
  assert.ok(grokConfig.hooks?.Notification, 'Notification must be registered for grok')

  // --- owned-json install round-trip on disk (grok spec) -------------------
  // Writes .grok/hooks/multicode-agent-state.json, copies the shared reporter,
  // references it by absolute path, and uninstall removes only our config file
  // (the reporter script is shared with the Claude/Codex installs).
  const grokRoot = await mkdtemp(join(tmpdir(), 'multicode-agent-state-grok-'))
  const grokReporter = join(grokRoot, 'reporter-src.mjs')
  await writeFile(grokReporter, '// reporter\n', 'utf8')
  const grokSocket = join(grokRoot, 'agent-state.sock')

  const grokInstalled = await installAgentStateReporter(grokRoot, grokSpec, {
    sourceScriptPath: grokReporter,
    socketPath: grokSocket,
  })
  assert.equal(grokInstalled.ok, true)
  const grokConfigPath = join(grokRoot, '.grok', 'hooks', 'multicode-agent-state.json')
  const grokOnDisk = JSON.parse(await readFile(grokConfigPath, 'utf8')) as Settings
  const grokEntry = grokOnDisk.hooks?.SessionStart?.[0]?.hooks?.[0]
  const grokScript = join(grokRoot, '.multicode', 'hooks', 'agent-state.mjs')
  assert.ok(existsSync(grokScript), 'grok install must copy the shared reporter')
  assert.ok(grokEntry?.command.includes(`node "${grokScript.split('\\').join('/')}"`), grokEntry?.command)
  assert.ok(!grokEntry?.command.includes('node ".multicode'), 'must not embed a relative script path')

  // Re-install is idempotent (whole-file overwrite, no accumulation).
  const grokReinstall = await installAgentStateReporter(grokRoot, grokSpec, {
    sourceScriptPath: grokReporter,
    socketPath: grokSocket,
  })
  assert.equal(grokReinstall.ok, true)
  const grokTwice = JSON.parse(await readFile(grokConfigPath, 'utf8')) as Settings
  assert.equal(grokTwice.hooks?.SessionStart?.length, 1, 'grok config duplicated on re-install')

  const grokRemoved = await uninstallAgentStateReporter(grokRoot, grokSpec)
  assert.equal(grokRemoved.ok, true)
  assert.equal(existsSync(grokConfigPath), false, 'uninstall left the grok hook config')
  assert.ok(existsSync(grokScript), 'grok uninstall must leave the shared reporter script')

  // Missing source script is a safe, reported failure (never throws).
  const grokMissing = await installAgentStateReporter(grokRoot, grokSpec, {
    sourceScriptPath: join(grokRoot, 'nope.mjs'),
    socketPath: grokSocket,
  })
  assert.equal(grokMissing.ok, false)

  // --- Cursor: manifest-driven mapping -------------------------------------
  const cursorSpec = await loadBundledSpec('cursor')
  assert.equal(resolvePhase(cursorSpec, 'sessionStart'), 'starting')
  assert.equal(resolvePhase(cursorSpec, 'beforeSubmitPrompt'), 'thinking')
  assert.equal(resolvePhase(cursorSpec, 'postToolUse'), 'thinking')
  assert.equal(resolvePhase(cursorSpec, 'postToolUseFailure'), 'thinking')
  assert.equal(resolvePhase(cursorSpec, 'sessionEnd'), 'exited')
  assert.deepEqual(flags(cursorSpec, 'stop'), { turnEnd: true, turnFailure: false })
  // Cursor's one turn-end event carries the outcome in its payload: error and
  // aborted flag the turn FAILED via failureWhen (an automation must not open
  // a PR from a crashed or interrupted turn), completed and an absent status
  // (a stale reporter, an undocumented payload change) stay a clean finish.
  const cursorStop = (status?: string) => resolveAgentStateEvent(cursorSpec, { event: 'stop', status })
  assert.deepEqual(cursorStop('error'), { action: 'apply', phase: 'idle', turnEnd: true, turnFailure: true })
  assert.deepEqual(cursorStop('aborted'), { action: 'apply', phase: 'idle', turnEnd: true, turnFailure: true })
  assert.deepEqual(cursorStop('completed'), { action: 'apply', phase: 'idle', turnEnd: true, turnFailure: false })
  assert.deepEqual(cursorStop(), { action: 'apply', phase: 'idle', turnEnd: true, turnFailure: false })
  // awaiting_input is deliberately unsupported (no Notification/PermissionRequest
  // analogue; see the manifest $comment) — no event may map to it.
  assert.ok(
    cursorSpec.events.every((entry) => entry.phase !== 'awaiting_input'),
    'cursor must not claim an awaiting_input signal it cannot substantiate'
  )
  // Permission-flow hooks must never be registered: they participate in
  // Cursor's approval decisions, and the reporter has no opinion to offer.
  for (const risky of ['beforeShellExecution', 'beforeMCPExecution']) {
    assert.ok(!cursorSpec.events.some((entry) => entry.event === risky), `${risky} must not be registered`)
  }

  // --- flat-hooks-json merge / unmerge round-trip (cursor spec) ------------
  const cursorRoot = await mkdtemp(join(tmpdir(), 'multicode-agent-state-cursor-'))
  const cursorReporter = join(cursorRoot, 'reporter-src.mjs')
  await writeFile(cursorReporter, '// reporter\n', 'utf8')
  const cursorHooksPath = join(cursorRoot, '.cursor', 'hooks.json')
  await mkdir(join(cursorRoot, '.cursor'), { recursive: true })
  // A user's own hook and a stale reporter entry from a moved workspace root:
  // the user's survives install + uninstall untouched; the stale one is
  // reclaimed by command shape (no _multicode tag exists in this format).
  await writeFile(
    cursorHooksPath,
    JSON.stringify({
      version: 1,
      hooks: {
        stop: [
          { command: 'notify-send done' },
          { command: 'node "/old/root/.multicode/hooks/agent-state.mjs" --socket "/old/agent.sock"' },
        ],
      },
    }, null, 2),
    'utf8'
  )

  const cursorInstalled = await installAgentStateReporter(cursorRoot, cursorSpec, {
    sourceScriptPath: cursorReporter,
    socketPath: join(cursorRoot, 'agent.sock'),
  })
  assert.equal(cursorInstalled.ok, true)
  type FlatFile = { version?: number; hooks?: Record<string, Array<{ command?: string }>> }
  let cursorFile = JSON.parse(await readFile(cursorHooksPath, 'utf8')) as FlatFile
  assert.equal(cursorFile.version, 1, 'version preserved')
  const cursorRegistered = registeredAgentStateEvents(cursorSpec)
  for (const { event } of cursorRegistered) {
    const entries = cursorFile.hooks?.[event] ?? []
    assert.equal(entries.filter((e) => e.command?.includes('/.multicode/hooks/agent-state.mjs')).length, 1, `one reporter entry for ${event}`)
  }
  assert.ok(cursorFile.hooks?.stop?.some((e) => e.command === 'notify-send done'), 'user stop hook survived install')
  assert.ok(
    !JSON.stringify(cursorFile).includes('/old/root/'),
    'stale reporter entry reclaimed by command shape'
  )
  assert.ok(!JSON.stringify(cursorFile).includes('_multicode'), 'no vendor-foreign tag key may be written')

  // Idempotent re-install: no duplicates.
  const cursorReinstall = await installAgentStateReporter(cursorRoot, cursorSpec, {
    sourceScriptPath: cursorReporter,
    socketPath: join(cursorRoot, 'agent.sock'),
  })
  assert.equal(cursorReinstall.ok, true)
  cursorFile = JSON.parse(await readFile(cursorHooksPath, 'utf8')) as FlatFile
  assert.equal(
    cursorFile.hooks?.stop?.filter((e) => e.command?.includes('/.multicode/hooks/agent-state.mjs')).length,
    1,
    'reporter entry duplicated on re-install'
  )

  // Uninstall removes ours, keeps the user's, prunes emptied event keys.
  const cursorRemoved = await uninstallAgentStateReporter(cursorRoot, cursorSpec)
  assert.equal(cursorRemoved.ok, true)
  cursorFile = JSON.parse(await readFile(cursorHooksPath, 'utf8')) as FlatFile
  assert.ok(cursorFile.hooks?.stop?.some((e) => e.command === 'notify-send done'), 'user hook lost on uninstall')
  assert.equal(cursorFile.hooks?.sessionStart, undefined, 'emptied event key must be pruned')

  // --- Kimi Code: manifest-driven mapping ----------------------------------
  const kimiSpec = await loadBundledSpec('kimi-code')
  assert.equal(resolvePhase(kimiSpec, 'SessionStart'), 'starting')
  assert.equal(resolvePhase(kimiSpec, 'UserPromptSubmit'), 'thinking')
  assert.equal(resolvePhase(kimiSpec, 'PostToolUse'), 'thinking')
  assert.equal(resolvePhase(kimiSpec, 'PostToolUseFailure'), 'thinking')
  // The awaiting-input pair: PermissionRequest lights it, PermissionResult is
  // the mid-turn clearer (the Kimi analogue of Claude's PostToolUse role).
  assert.equal(resolvePhase(kimiSpec, 'PermissionRequest'), 'awaiting_input')
  assert.equal(resolvePhase(kimiSpec, 'PermissionResult'), 'thinking')
  assert.equal(resolvePhase(kimiSpec, 'SessionEnd'), 'exited')
  assert.deepEqual(flags(kimiSpec, 'Stop'), { turnEnd: true, turnFailure: false })
  // StopFailure shares Stop's idle phase but is a crashed turn — only the flag
  // keeps an automation from finalizing it as completed.
  assert.deepEqual(flags(kimiSpec, 'StopFailure'), { turnEnd: false, turnFailure: true })
  // Unregistered/high-frequency events (heartbeats, compaction) stay unmapped.
  assert.equal(resolvePhase(kimiSpec, 'SessionHeartbeat'), null)
  assert.equal(resolvePhase(kimiSpec, 'TurnStarted'), null)
  // User-global config: the registration must be user-scoped or the write
  // lands in the workspace where kimi never reads it.
  assert.equal(kimiSpec.registration.scope, 'user')
  assert.equal(kimiSpec.registration.kind, 'toml-array-block')

  // --- toml-array-block render / merge (kimi spec) -------------------------
  const kimiRegistered = registeredAgentStateEvents(kimiSpec)
  const kimiBlock = renderTomlArrayAgentStateHooksBlock('node "/abs/agent-state.mjs" --socket "/s.sock"', kimiRegistered)
  assert.ok(kimiBlock.startsWith('# >>> multicode agent-state hooks managed'))
  assert.ok(kimiBlock.includes('[[hooks]]\nevent = "PermissionRequest"'), kimiBlock)
  assert.ok(!kimiBlock.includes('[[hooks.'), 'array-of-tables shape, never the Codex nesting')
  assert.equal((kimiBlock.match(/^\[\[hooks\]\]$/gmu) ?? []).length, kimiRegistered.length)

  const kimiUserToml = 'default_model = "kimi-k3"\n\n[[hooks]]\nevent = "PostToolUse"\ncommand = "prettier --write"\n'
  const kimiMergedOnce = mergeTomlArrayAgentStateHooks(kimiUserToml, 'node "/x.mjs" --socket "/s.sock"', kimiRegistered)
  assert.ok(kimiMergedOnce.includes('default_model = "kimi-k3"'), 'user config dropped')
  assert.ok(kimiMergedOnce.includes('command = "prettier --write"'), 'user hook dropped')
  const kimiMergedTwice = mergeTomlArrayAgentStateHooks(kimiMergedOnce, 'node "/x.mjs" --socket "/s.sock"', kimiRegistered)
  assert.equal(
    (kimiMergedTwice.match(/# >>> multicode agent-state hooks managed/gu) ?? []).length,
    1,
    'kimi block duplicated on re-merge'
  )
  assert.ok(unmergeTomlAgentStateHooks(kimiMergedOnce).includes('prettier --write'), 'unmerge dropped user hook')
  assert.ok(!unmergeTomlAgentStateHooks(kimiMergedOnce).includes('agent-state.mjs'), 'unmerge left our block')

  // --- user-scoped install resolves against homeDir, not the workspace -----
  const kimiWorkspace = await mkdtemp(join(tmpdir(), 'multicode-agent-state-kimi-ws-'))
  const kimiHome = await mkdtemp(join(tmpdir(), 'multicode-agent-state-kimi-home-'))
  const kimiReporter = join(kimiWorkspace, 'reporter-src.mjs')
  await writeFile(kimiReporter, '// reporter\n', 'utf8')

  // The socket path deliberately lives OUTSIDE the workspace (as in prod,
  // where it is under userData): the assertion below is that no
  // workspace-lifetime path reaches the user-global config.
  const kimiInstalled = await installAgentStateReporter(kimiWorkspace, kimiSpec, {
    sourceScriptPath: kimiReporter,
    socketPath: join(kimiHome, 'agent.sock'),
    homeDir: kimiHome,
  })
  assert.equal(kimiInstalled.ok, true)
  const kimiConfigPath = join(kimiHome, '.kimi-code', 'config.toml')
  assert.ok(existsSync(kimiConfigPath), 'user-scoped registration must land under homeDir')
  assert.ok(!existsSync(join(kimiWorkspace, '.kimi-code')), 'user-scoped registration must not touch the workspace')
  const kimiConfig = await readFile(kimiConfigPath, 'utf8')
  assert.ok(kimiConfig.includes('event = "Stop"'))
  // The reporter copy lives under HOME for a user-scoped registration: a
  // user-global config pointing into a workspace would dangle machine-wide
  // the moment that workspace (or a finalize-deleted sprint worktree) is
  // removed, firing MODULE_NOT_FOUND on every event of every kimi session.
  const kimiHomeScript = join(kimiHome, '.multicode', 'hooks', 'agent-state.mjs')
  assert.ok(existsSync(kimiHomeScript), 'user-scoped registration must copy the reporter under homeDir')
  assert.ok(kimiConfig.includes(kimiHomeScript.split('\\').join('/')), kimiConfig)
  assert.ok(
    !kimiConfig.includes(kimiWorkspace),
    'a user-global config must not reference any workspace-lifetime path'
  )

  const kimiRemoved = await uninstallAgentStateReporter(kimiWorkspace, kimiSpec, { homeDir: kimiHome })
  assert.equal(kimiRemoved.ok, true)
  assert.ok(!(await readFile(kimiConfigPath, 'utf8')).includes('agent-state.mjs'), 'uninstall left the kimi block')

  console.log('agent-state.test.ts: all assertions passed')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
