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
  applyBackgroundWork,
  canonicalEventName,
  buildAgentStateReporterCommand,
  deriveActivityFromPhase,
  evaluateAgentStall,
  holdTurnEndForBackgroundWork,
  installAgentStateReporter,
  isAtRestAgentPhase,
  MAX_FILE_CHANGE_COUNT,
  MAX_FILE_CHANGE_EDITS,
  MAX_FILE_CHANGE_PATH_LENGTH,
  MAX_STATUS_LINE_COST_USD,
  MAX_STATUS_LINE_COUNT,
  MAX_STATUS_LINE_NAME_LENGTH,
  MAX_TOOL_USE_ID_LENGTH,
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
  // Every bundled manifest that declares an agentStateSpec (the canonical-fold
  // collision sweep below must see all of them, not just the ones named above).
  const BUNDLED_AGENT_STATE_PLUGINS = [
    'claude-code', 'codex', 'cursor', 'grok', 'kimi-claude', 'kimi-code', 'opencode', 'zai',
  ] as const

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
  const flagsFor = (spec: PluginAgentStateSpec, event: string) => {
    const r = resolveAgentStateEvent(spec, { event, notificationType: undefined })
    return r.action === 'apply' ? { turnEnd: r.turnEnd, turnFailure: r.turnFailure } : null
  }
  const cursorSpecForSpelling = await loadBundledSpec('cursor')

  // --- event → phase mapping (manifest-driven) ----------------------------
  assert.equal(resolvePhase(claudeSpec, 'SessionStart'), 'starting')
  assert.equal(resolvePhase(claudeSpec, 'UserPromptSubmit'), 'thinking')
  assert.equal(resolvePhase(claudeSpec, 'PreToolUse'), 'tool_use')
  assert.equal(resolvePhase(claudeSpec, 'PostToolUse'), 'thinking')
  // Claude's CwdChanged is deliberately NOT registered (MC-2440): older
  // `claude` builds skip a settings value they cannot validate, so an unknown
  // hook event name could cost the whole hooks block, and the cwd it would
  // carry already rides the PostToolUse frame of the tool call that moved it.
  // An unregistered frame for it (a stale registration) drops like any other.
  assert.equal(resolvePhase(claudeSpec, 'CwdChanged'), null)
  assert.ok(!registeredAgentStateEvents(claudeSpec).some((e) => e.event === 'CwdChanged'))
  assert.equal(resolvePhase(claudeSpec, 'Stop'), 'idle')
  // A subagent starting or stopping is the PARENT doing work: never idle.
  assert.equal(resolvePhase(claudeSpec, 'SubagentStart'), 'tool_use')
  assert.equal(resolvePhase(claudeSpec, 'SubagentStop'), 'thinking')
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

  // --- event-name spelling is canonical, not exact (MC-2520) ---------------
  // Grok Build reads `PreToolUse` in .grok/hooks/*.json but stamps the payload
  // `"hookEventName": "pre_tool_use"`, so an exact compare dropped EVERY Grok
  // frame and a Grok agent never left `starting`. The manifest keeps the CLI's
  // written PascalCase; matching folds case and _/- on both sides.
  assert.equal(canonicalEventName('PreToolUse'), 'pretooluse')
  assert.equal(canonicalEventName('pre_tool_use'), 'pretooluse')
  assert.equal(canonicalEventName('pre-tool-use'), 'pretooluse')
  assert.equal(
    canonicalEventName('session.idle'),
    'session.idle',
    'dots are structure (OpenCode), never folded away'
  )

  // Both spellings of every Grok event resolve to the SAME phase.
  for (const entry of grokSpec.events) {
    const snake = entry.event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    assert.notEqual(snake, entry.event, `${entry.event} should have a distinct snake_case spelling`)
    const notificationType = entry.when ? entry.when.oneOf[0] : undefined
    assert.equal(
      resolvePhase(grokSpec, snake, notificationType),
      resolvePhase(grokSpec, entry.event, notificationType),
      `grok ${snake} must resolve like ${entry.event}`
    )
    assert.equal(
      resolvePhase(grokSpec, entry.event, notificationType),
      entry.phase,
      `grok ${entry.event} must still match its manifest phase exactly`
    )
  }
  // The real bug, end to end: the payload spelling now carries turn end too.
  assert.deepEqual(flagsFor(grokSpec, 'stop'), { turnEnd: true, turnFailure: false })
  assert.equal(resolvePhase(grokSpec, 'pre_tool_use'), 'tool_use')
  assert.equal(resolvePhase(grokSpec, 'session_end'), 'exited')
  // PascalCase manifests still match their own exact spelling (no regression).
  assert.equal(resolvePhase(claudeSpec, 'PreToolUse'), 'tool_use')
  assert.equal(resolvePhase(cursorSpecForSpelling, 'sessionStart'), 'starting')
  // Folding must not turn an unrelated name into a match.
  assert.deepEqual(resolveAgentStateEvent(grokSpec, { event: 'pre_tool_used', phase: 'thinking' }), { action: 'drop' })
  assert.deepEqual(resolveAgentStateEvent(grokSpec, { event: 'not_an_event', phase: 'thinking' }), { action: 'drop' })
  assert.deepEqual(resolveAgentStateEvent(grokSpec, { event: 'stopping', phase: 'idle' }), { action: 'drop' })

  // ADVERSARIAL: canonical matching makes the FIRST canonical match win, so no
  // shipped manifest may declare two events that fold to the same name.
  for (const pluginId of BUNDLED_AGENT_STATE_PLUGINS) {
    const spec = await loadBundledSpec(pluginId)
    const seen = new Map<string, string>()
    for (const entry of spec.events) {
      const key = canonicalEventName(entry.event)
      const prior = seen.get(key)
      assert.equal(prior, undefined, `${pluginId}: ${prior} and ${entry.event} fold to the same event`)
      seen.set(key, entry.event)
    }
  }

  // --- turn-end / turn-failure flags (manifest-declared) -------------------
  // SubagentStop is a subagent finishing, not the session's turn end, and
  // session.error maps to `idle` like session.idle but is a crash — either one
  // read as a turn end finalizes work that isn't done.
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

  // --- background work (manifest-declared, counted by the runtime) ---------
  // Claude fires Stop when it parks the model on "waiting for N background
  // agents" and re-invokes it when they finish; read as a turn end, that Stop
  // marked rows finished and finalized runs mid-work. The manifest names the
  // events that open and close such work, and the resolution carries the flag.
  const background = (spec: PluginAgentStateSpec, event: string) => {
    const r = resolveAgentStateEvent(spec, { event, notificationType: undefined })
    return r.action === 'apply' ? r.background ?? null : null
  }
  assert.equal(background(claudeSpec, 'SubagentStart'), 'start')
  assert.equal(background(claudeSpec, 'SubagentStop'), 'stop')
  assert.equal(background(claudeSpec, 'Stop'), null)
  assert.equal(background(codexSpec, 'SubagentStop'), null, 'codex awaits live verification of SubagentStart')
  assert.equal(applyBackgroundWork(0, 'start'), 1)
  assert.equal(applyBackgroundWork(2, 'stop'), 1)
  assert.equal(applyBackgroundWork(0, 'stop'), 0, 'a stop with nothing open clamps — the start predates the reporter')
  assert.equal(applyBackgroundWork(1, undefined), 1)
  const stop = { action: 'apply' as const, phase: 'idle' as const, turnEnd: true, turnFailure: false }
  assert.deepEqual(holdTurnEndForBackgroundWork(stop, 0), stop, 'nothing outstanding: the turn end stands')
  assert.deepEqual(
    holdTurnEndForBackgroundWork(stop, 1),
    { ...stop, phase: 'tool_use', turnEnd: false },
    'work outstanding: held as working, and no consumer may finalize'
  )
  const failedStop = { ...stop, turnFailure: true }
  assert.deepEqual(holdTurnEndForBackgroundWork(failedStop, 1), failedStop, 'a failed turn is over whatever is outstanding')
  const subagentStop = { action: 'apply' as const, phase: 'thinking' as const, turnEnd: false, turnFailure: false, background: 'stop' as const }
  assert.deepEqual(holdTurnEndForBackgroundWork(subagentStop, 3), subagentStop, 'only a turn end is ever held')

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
  // FileChanged is the second map-only event (agent changelists): the reporter
  // reads it, but nothing arms its watch paths yet, so it is not written either.
  assert.ok(!claudeRegistered.some((e) => e.event === 'FileChanged'), 'FileChanged must not be registered')
  assert.equal(
    claudeRegistered.length,
    claudeSpec.events.filter((e) => e.register !== false).length,
  )
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
  // …the observed cwd (MC-2440) must be absolute on some platform and capped;
  // a bad value drops the field, never the frame…
  const cwdOf = (cwd: unknown) =>
    parseAgentStateFrame({ type: 'agent_state', agentId: 'a1', event: 'PostToolUse', ts: 5, cwd }, 999)?.cwd
  assert.equal(cwdOf('/Users/me/proj'), '/Users/me/proj')
  assert.equal(cwdOf('/Users/me/proj\n'), '/Users/me/proj', 'a newline-terminated cwd is trimmed')
  assert.equal(cwdOf('C:\\Users\\me\\proj'), 'C:\\Users\\me\\proj', 'Windows drive path')
  assert.equal(cwdOf('C:/Users/me/proj'), 'C:/Users/me/proj', 'forward-slashed Windows drive path')
  assert.equal(cwdOf('\\\\server\\share\\proj'), '\\\\server\\share\\proj', 'UNC path')
  assert.equal(cwdOf('proj/sub'), undefined, 'relative cwd is dropped')
  assert.equal(cwdOf('./proj'), undefined, 'dot-relative cwd is dropped')
  assert.equal(cwdOf('~/proj'), undefined, 'tilde cwd is dropped (not absolute)')
  assert.equal(cwdOf(''), undefined)
  assert.equal(cwdOf('   '), undefined)
  assert.equal(cwdOf(42), undefined)
  assert.equal(cwdOf('/' + 'x'.repeat(5000)), undefined, 'oversized cwd is dropped')
  assert.equal(
    parseAgentStateFrame({ type: 'agent_state', agentId: 'a1', event: 'PostToolUse', ts: 5, cwd: 'relative' }, 999)?.event,
    'PostToolUse',
    'a bad cwd never drops the frame'
  )
  // …the file ledger's change rides the same rules: absolute path, bounded, and
  // counts that are real, whole and not negative. A bad one drops the FIELD —
  // a malformed count must never cost the session the phase it rode in with…
  const changeOf = (fileChange: unknown) =>
    parseAgentStateFrame({ type: 'agent_state', agentId: 'a1', event: 'PostToolUse', ts: 5, fileChange }, 999)
      ?.fileChange
  assert.deepEqual(
    changeOf({ path: '/repo/src/app.ts', additions: 12, deletions: 3 }),
    { path: '/repo/src/app.ts', additions: 12, deletions: 3 }
  )
  assert.deepEqual(
    changeOf({ path: '/repo/new.ts', additions: 0, deletions: 0 }),
    { path: '/repo/new.ts', additions: 0, deletions: 0 },
    'a touched-but-uncounted file (an unverified MultiEdit shape) is still recorded'
  )
  assert.deepEqual(
    changeOf({ path: 'src/app.ts', additions: 1, deletions: 0 }),
    undefined,
    'a relative path is meaningless off the reporter’s own cwd'
  )
  assert.equal(changeOf({ path: '/repo/a.ts', additions: -1, deletions: 0 }), undefined, 'negative additions')
  assert.equal(changeOf({ path: '/repo/a.ts', additions: 0, deletions: -4 }), undefined, 'negative deletions')
  assert.equal(changeOf({ path: '/repo/a.ts', additions: Number.NaN, deletions: 0 }), undefined)
  assert.equal(changeOf({ path: '/repo/a.ts', additions: Infinity, deletions: 0 }), undefined)
  assert.equal(changeOf({ path: '/repo/a.ts', additions: '4', deletions: 0 }), undefined, 'counts are numbers')
  assert.equal(changeOf({ path: '/repo/a.ts', deletions: 0 }), undefined, 'both counts are required')
  assert.equal(changeOf({ path: '/' + 'x'.repeat(MAX_FILE_CHANGE_PATH_LENGTH), additions: 1, deletions: 0 }), undefined)
  assert.deepEqual(
    changeOf({ path: '/' + 'x'.repeat(MAX_FILE_CHANGE_PATH_LENGTH - 1), additions: 1, deletions: 0 })?.path?.length,
    MAX_FILE_CHANGE_PATH_LENGTH,
    'a path exactly at the cap is a path, not an anomaly'
  )
  assert.deepEqual(
    changeOf({ path: 'C:\\repo\\a.ts', additions: 1, deletions: 0 }),
    { path: 'C:\\repo\\a.ts', additions: 1, deletions: 0 },
    'the ledger is cross-platform: a Windows drive path is absolute'
  )
  // `isAbsoluteObservedPath` only reads a path's prefix, so what follows must be
  // refused here: this value is retained per session, written to a sidecar,
  // keyed on, and painted in every window.
  assert.equal(changeOf({ path: '/repo/\u0000evil.ts', additions: 1, deletions: 0 }), undefined, 'a NUL is not a path')
  assert.equal(
    changeOf({ path: '/repo/\u001b[31mevil.ts', additions: 1, deletions: 0 }),
    undefined,
    'an ANSI escape is not a path'
  )
  assert.equal(
    changeOf({ path: '/repo/two\nlines.ts', additions: 1, deletions: 0 }),
    undefined,
    'an embedded newline is not a path'
  )
  assert.equal(cwdOf('/repo/\u0000evil'), undefined, 'the observed cwd is held to the same rule')
  assert.equal(changeOf({ additions: 1, deletions: 0 }), undefined, 'a change with no path names nothing')
  assert.equal(changeOf('/repo/a.ts'), undefined, 'a bare string is not a change')
  assert.deepEqual(
    changeOf({ path: '  /repo/a.ts  ', additions: 3.7, deletions: 1e12 }),
    { path: '/repo/a.ts', additions: 3, deletions: MAX_FILE_CHANGE_COUNT },
    'the path is trimmed, a fractional count floors, an absurd one caps'
  )
  assert.equal(
    parseAgentStateFrame(
      { type: 'agent_state', agentId: 'a1', event: 'PostToolUse', ts: 5, fileChange: { path: 'nope' } },
      999
    )?.event,
    'PostToolUse',
    'a bad file change never drops the frame'
  )
  // …and the changed REGIONS the agent's changelist is built from ride the same
  // rules one level down: four whole non-negative ints each (zero is legal on a
  // `start`, because `+0,0` is git's own spelling for a deletion at the head of
  // a file), capped, and a malformed member drops the FIELD, never the frame.
  const editsOf = (edits: unknown) => changeOf({ path: '/repo/a.ts', additions: 1, deletions: 0, edits })?.edits
  assert.deepEqual(
    editsOf([{ oldStart: 2, oldLines: 2, newStart: 2, newLines: 3 }]),
    [{ oldStart: 2, oldLines: 2, newStart: 2, newLines: 3 }],
    'a well-formed region survives verbatim'
  )
  assert.deepEqual(
    editsOf([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 4 }]),
    [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 4 }],
    'a whole-file creation anchors at 0, which is a start, not an anomaly'
  )
  assert.equal(editsOf(undefined), undefined, 'no regions is a file-level claim, not an error')
  assert.equal(editsOf([]), undefined, 'and neither is an empty list')
  assert.equal(editsOf('1,2,3,4'), undefined, 'the regions are a list')
  assert.equal(
    editsOf([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }, { oldStart: -1, oldLines: 0, newStart: 1, newLines: 1 }]),
    undefined,
    'one malformed region drops every region: half a claim is a wrong claim'
  )
  assert.equal(editsOf([{ oldStart: 1, oldLines: 1, newStart: 1 }]), undefined, 'all four numbers are required')
  assert.equal(editsOf([{ oldStart: 1.5, oldLines: 1, newStart: 1, newLines: 1 }]), undefined, 'lines are whole')
  assert.equal(editsOf([{ oldStart: Number.NaN, oldLines: 1, newStart: 1, newLines: 1 }]), undefined)
  assert.equal(
    changeOf({
      path: '/repo/a.ts',
      additions: 1,
      deletions: 0,
      edits: Array.from({ length: MAX_FILE_CHANGE_EDITS + 40 }, (_unused, index) => ({
        oldStart: index + 1,
        oldLines: 1,
        newStart: index + 1,
        newLines: 1,
      })),
    })?.edits?.length,
    MAX_FILE_CHANGE_EDITS,
    'a rewrite past the cap is truncated — the regions ascend, so the kept ones are still right'
  )
  assert.deepEqual(
    parseAgentStateFrame(
      {
        type: 'agent_state',
        agentId: 'a1',
        event: 'PostToolUse',
        ts: 5,
        fileChange: { path: '/repo/a.ts', additions: 1, deletions: 0, edits: [{ oldStart: 'x' }] },
      },
      999
    )?.fileChange,
    { path: '/repo/a.ts', additions: 1, deletions: 0 },
    'a malformed region list drops the field, and the file is still reported'
  )
  // …and the status line's reading rides its own: a percentage that IS one,
  // rounded to a whole percent; counts that are real, whole and not negative; a
  // cost that is money; names that are bounded and free of control characters.
  // Each field stands or falls alone — a bad cost must not cost the session its
  // context percentage — and a reading with nothing valid in it drops entirely,
  // so "present" means "there is something to fold".
  const statusOf = (statusLine: unknown) =>
    parseAgentStateFrame({ type: 'agent_state', agentId: 'a1', event: 'StatusLine', ts: 5, statusLine }, 999)
      ?.statusLine
  assert.deepEqual(
    statusOf({
      usedPercentage: 8.4,
      contextWindowSize: 200_000,
      totalCostUsd: 0.01234,
      linesAdded: 156,
      linesRemoved: 23,
      model: 'Opus',
      sessionName: 'hook ledger',
    }),
    {
      usedPercentage: 8,
      contextWindowSize: 200_000,
      totalCostUsd: 0.01234,
      linesAdded: 156,
      linesRemoved: 23,
      model: 'Opus',
      sessionName: 'hook ledger',
    },
    'the percentage rounds to a whole percent; the cost keeps its fraction'
  )
  assert.equal(statusOf({ usedPercentage: 8.6 })?.usedPercentage, 9, 'rounds, not floors')
  assert.deepEqual(statusOf({ usedPercentage: 0 }), { usedPercentage: 0 }, 'zero is a reading, not an absence')
  assert.deepEqual(statusOf({ usedPercentage: 100 }), { usedPercentage: 100 })
  // Refused rather than clamped: a forwarder reporting 900% has read the wrong
  // field, and clamping would paint a full ring on an empty session.
  assert.equal(statusOf({ usedPercentage: 101 }), undefined, 'a percentage above 100 is not a percentage')
  assert.equal(statusOf({ usedPercentage: -1 }), undefined)
  assert.equal(statusOf({ usedPercentage: Number.NaN }), undefined)
  assert.equal(statusOf({ usedPercentage: '8' }), undefined, 'a percentage is a number')
  assert.deepEqual(
    statusOf({ usedPercentage: 12, totalCostUsd: -1, linesAdded: -2, model: 42 }),
    { usedPercentage: 12 },
    'a bad field drops alone — the reading beside it survives'
  )
  assert.equal(statusOf({ totalCostUsd: 0 })?.totalCostUsd, 0, 'a free session costs zero, which is a fact')
  assert.equal(
    statusOf({ totalCostUsd: 1e300 })?.totalCostUsd,
    MAX_STATUS_LINE_COST_USD,
    'money is bounded too — every number off this socket is'
  )
  assert.equal(statusOf({ totalCostUsd: 0.5 })?.totalCostUsd, 0.5, 'but it keeps the fraction the counts floor away')
  assert.deepEqual(
    statusOf({ contextWindowSize: 200_000.7, linesAdded: 1e12 }),
    { contextWindowSize: 200_000, linesAdded: MAX_STATUS_LINE_COUNT },
    'counts floor, an absurd one caps'
  )
  assert.equal(statusOf({ model: '  Opus  ' })?.model, 'Opus', 'a name is trimmed')
  assert.equal(statusOf({ model: 'x'.repeat(MAX_STATUS_LINE_NAME_LENGTH) })?.model?.length, MAX_STATUS_LINE_NAME_LENGTH)
  assert.equal(statusOf({ model: 'x'.repeat(MAX_STATUS_LINE_NAME_LENGTH + 1) }), undefined, 'over the cap drops')
  // The names are retained per session, written to a sidecar and painted in
  // every window, so they are held to the ledger path's rule.
  assert.equal(statusOf({ sessionName: 'ledger\u001b[31m' }), undefined, 'an ANSI escape is not a name')
  assert.equal(statusOf({ sessionName: 'two\nlines' }), undefined, 'an embedded newline is not a name')
  assert.equal(statusOf({ sessionName: 'nul\u0000' }), undefined, 'a NUL is not a name')
  assert.equal(statusOf({}), undefined, 'an empty reading is no reading')
  // Every `undefined` above is read off a frame, so each one would also pass if
  // the FRAME had been dropped. It is not: a bad field costs the field only.
  for (const bad of [{ sessionName: 'x'.repeat(9000) }, { usedPercentage: 900, model: 42 }]) {
    const frame = parseAgentStateFrame(
      { type: 'agent_state', agentId: 'a1', event: 'StatusLine', ts: 5, statusLine: bad },
      999
    )
    assert.equal(frame?.event, 'StatusLine', `the frame survives ${JSON.stringify(bad)}`)
    assert.equal(frame?.statusLine, undefined)
  }
  assert.equal(statusOf({ usedPercentage: null }), undefined, 'a null percentage alone is no reading')
  assert.equal(statusOf('8%'), undefined, 'a bare string is not a reading')
  assert.equal(statusOf([8]), undefined, 'an array is not a reading')
  assert.equal(
    parseAgentStateFrame(
      { type: 'agent_state', agentId: 'a1', event: 'StatusLine', ts: 5, statusLine: { usedPercentage: 900 } },
      999
    )?.event,
    'StatusLine',
    'a bad status line never drops the frame'
  )
  // …a captured pull request rides the app's ONE URL parser: the reporter's
  // regex is a wire-side twin, and this is where the two meet. What is not a
  // GitHub or GitHub Enterprise pull request URL drops the FIELD — never the
  // frame, which is also carrying the phase and the cwd of the same tool call.
  const prOf = (pullRequest: unknown) =>
    parseAgentStateFrame({ type: 'agent_state', agentId: 'a1', event: 'PostToolUse', ts: 5, pullRequest }, 999)
      ?.pullRequest
  assert.deepEqual(
    prOf({ url: 'https://github.com/acme/app/pull/12' }),
    { url: 'https://github.com/acme/app/pull/12' }
  )
  assert.deepEqual(
    prOf({ url: 'https://github.example.com:8443/acme/app/pull/77' }),
    { url: 'https://github.example.com:8443/acme/app/pull/77' },
    'a GitHub Enterprise host is a pull request host'
  )
  assert.deepEqual(
    prOf({ url: '  https://github.com/acme/app/pull/9/files?w=1  ' }),
    { url: 'https://github.com/acme/app/pull/9/files?w=1' },
    'a trailing tab and query survive validation — the record canonicalises them on the way in'
  )
  assert.equal(prOf({ url: 'https://github.com/acme/app/issues/12' }), undefined, 'an issue is not a pull request')
  assert.equal(prOf({ url: 'https://github.com/acme/app/commit/9f2c1ab' }), undefined, 'a commit is not a pull request')
  assert.equal(
    prOf({ url: 'https://bitbucket.org/acme/app/pull-requests/4' }),
    undefined,
    'a typed "unsupported" is not a capture either'
  )
  assert.equal(prOf({ url: 'not a url at all' }), undefined)
  assert.equal(prOf({ url: 'javascript:alert(1)' }), undefined, 'only http(s) is a pull request URL')
  assert.equal(
    prOf({ url: `https://github.com/acme/${'x'.repeat(3000)}/pull/1` }),
    undefined,
    'an absurd URL is a broken reporter, not a pull request'
  )
  assert.equal(prOf({ url: 'https://github.com/acme/app/pull/12\u001b[31m' }), undefined, 'an ANSI escape is not a URL')
  assert.equal(prOf({ url: '' }), undefined)
  assert.equal(prOf({ url: 12 }), undefined)
  assert.equal(prOf('https://github.com/acme/app/pull/12'), undefined, 'a bare string is not the field')
  assert.equal(prOf(undefined), undefined)
  // Every `undefined` above is read off a frame, so each would also pass if the
  // FRAME had been dropped. It is not: a bad capture costs the capture only.
  const badPrFrame = parseAgentStateFrame(
    {
      type: 'agent_state',
      agentId: 'a1',
      event: 'PostToolUse',
      ts: 5,
      cwd: '/repo',
      pullRequest: { url: 'https://github.com/acme/app/issues/12' },
    },
    999
  )
  assert.equal(badPrFrame?.cwd, '/repo', 'a malformed capture never costs the frame the rest of its truth')
  assert.equal(badPrFrame?.pullRequest, undefined)
  // …the tool-call id — the duplicate-registration guard's key — rides the same
  // rules again. It is only ever compared for equality, so an oversized one is
  // DROPPED rather than truncated: a truncated id could collide with a real
  // other call's, which would silently swallow a genuine edit…
  const idOf = (toolUseId: unknown) =>
    parseAgentStateFrame({ type: 'agent_state', agentId: 'a1', event: 'PostToolUse', ts: 5, toolUseId }, 999)
      ?.toolUseId
  assert.equal(idOf('toolu_01PEv1LG8ZsV17KL86fXpeAx'), 'toolu_01PEv1LG8ZsV17KL86fXpeAx')
  assert.equal(idOf('  toolu_padded  '), 'toolu_padded', 'trimmed, like every other id off this socket')
  assert.equal(idOf('x'.repeat(MAX_TOOL_USE_ID_LENGTH)), 'x'.repeat(MAX_TOOL_USE_ID_LENGTH), 'exactly the cap is fine')
  assert.equal(idOf('x'.repeat(MAX_TOOL_USE_ID_LENGTH + 1)), undefined, 'over the cap the id is dropped, never truncated')
  assert.equal(idOf('toolu\u0000forged'), undefined, 'a control character would let one id forge another`s ring key')
  assert.equal(idOf('toolu\nnewline'), undefined)
  assert.equal(idOf(''), undefined)
  assert.equal(idOf('   '), undefined)
  assert.equal(idOf(42), undefined)
  assert.equal(idOf({ id: 'toolu_x' }), undefined)
  assert.equal(
    parseAgentStateFrame(
      { type: 'agent_state', agentId: 'a1', event: 'PostToolUse', ts: 5, toolUseId: 'x'.repeat(9000), cwd: '/repo' },
      999
    )?.cwd,
    '/repo',
    'a malformed id drops the FIELD and never the frame'
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
  assert.deepEqual(evaluateAgentStall({ ...stallBase, phase: 'tool_use', source: 'lifecycle' }), { action: 'clear' })
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
  assert.deepEqual(evaluateAgentStall({ ...stallBase, phase: 'starting', source: 'lifecycle' }), { action: 'stalled' })
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

  // SPELLING (MC-2520): the config file keeps the manifest's PascalCase, which
  // is NOT folded on the way out — canonical matching is for incoming frames
  // only. Verified against grok 1.0.13 on 2026-09-09: `grok inspect` loads a
  // PascalCase .grok/hooks/*.json (all 15 events) and drops unknown names, so
  // this is a spelling the binary actually reads.
  for (const key of Object.keys(grokConfig.hooks ?? {})) {
    assert.match(key, /^[A-Z][A-Za-z]*$/, `grok config event ${key} must stay PascalCase`)
  }
  assert.ok(grokConfig.hooks?.SessionStart, 'grok config must spell SessionStart, not session_start')
  assert.equal(grokConfig.hooks?.session_start, undefined, 'grok config must not emit snake_case')
  assert.deepEqual(
    Object.keys(JSON.parse(renderOwnedJsonAgentStateHooksConfig('cmd', [{ event: 'SessionStart' }, { event: 'session_end' }])).hooks),
    ['SessionStart', 'session_end'],
    'the emitter writes each event exactly as given — no folding, no rewriting'
  )

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

  // --- status line: install, wrap, precedence, restore ---------------------
  // The forwarder is installed alongside the hooks for a Claude-family
  // settings-json spec that opts in, and it must never cost a person the status
  // line they already had.
  const statusLineScript = join(process.cwd(), 'resources', 'hooks', 'multicode-status-line.mjs')
  assert.ok(existsSync(statusLineScript), `status-line forwarder not found at ${statusLineScript}`)
  assert.equal(claudeSpec.statusLine, true, 'claude-code must opt into the status line')
  assert.equal((await loadBundledSpec('zai')).statusLine, true, 'zai must opt into the status line')
  assert.equal((await loadBundledSpec('kimi-claude')).statusLine, true, 'kimi-claude must opt into the status line')
  assert.equal(codexSpec.statusLine, undefined, 'a non-Claude spec must not declare a status line')

  type StatusLineWorld = { root: string; home: string; settingsPath: string; socket: string }

  async function seedStatusLineWorld(seed: {
    local?: unknown
    project?: unknown
    user?: unknown
  }): Promise<StatusLineWorld> {
    const home = await mkdtemp(join(tmpdir(), 'agent-state-sl-home-'))
    const root = await mkdtemp(join(tmpdir(), 'agent-state-sl-ws-'))
    await mkdir(join(root, '.claude'), { recursive: true })
    await mkdir(join(home, '.claude'), { recursive: true })
    const write = async (path: string, value: unknown): Promise<void> => {
      await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
    }
    if (seed.local !== undefined) await write(join(root, '.claude', 'settings.local.json'), seed.local)
    if (seed.project !== undefined) await write(join(root, '.claude', 'settings.json'), seed.project)
    if (seed.user !== undefined) await write(join(home, '.claude', 'settings.json'), seed.user)
    return { root, home, settingsPath: join(root, '.claude', 'settings.local.json'), socket: join(root, 'agent.sock') }
  }

  const installStatusLine = (world: StatusLineWorld, env: NodeJS.ProcessEnv = {}) =>
    installAgentStateReporter(world.root, claudeSpec, {
      sourceScriptPath,
      socketPath: world.socket,
      statusLineScriptPath: statusLineScript,
      homeDir: world.home,
      env,
    })

  const readStatusLine = async (world: StatusLineWorld): Promise<Record<string, any>> =>
    JSON.parse(await readFile(world.settingsPath, 'utf8')) as Record<string, any>

  const wrapArgOf = (command: string): unknown => {
    const match = /--wrap "([A-Za-z0-9+/=]+)"/.exec(command)
    if (!match) return null
    return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
  }

  // 1. No prior status line anywhere: ours goes in unwrapped, other keys stand.
  {
    const world = await seedStatusLineWorld({ local: { permissions: { allow: ['Bash(ls:*)'] } } })
    assert.equal((await installStatusLine(world)).ok, true)
    const settings = await readStatusLine(world)
    assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] }, 'unrelated keys must survive install')
    assert.ok(settings.hooks, 'the hooks merge must still have happened')
    assert.equal(settings.statusLine.type, 'command')
    assert.equal(settings.statusLine._multicode, true)
    assert.equal(settings.statusLine._multicodeWrapped, null)
    assert.equal(settings.statusLine._multicodeWrappedFrom, undefined)
    assert.ok(!('padding' in settings.statusLine), 'no padding to carry, so none is written')
    assert.ok(!settings.statusLine.command.includes('--wrap'), settings.statusLine.command)
    // Absolute path to the copied script, forward-slashed, exactly like the
    // reporter command — a relative one would misresolve off the session cwd.
    const expectedScript = join(world.root, '.multicode', 'hooks', 'status-line.mjs').split('\\').join('/')
    assert.ok(
      settings.statusLine.command.startsWith(`node "${expectedScript}" --socket "${world.socket}"`),
      settings.statusLine.command
    )
    assert.ok(existsSync(join(world.root, '.multicode', 'hooks', 'status-line.mjs')), 'forwarder not copied')

    // Uninstall wrapped nothing, so the key goes entirely — and the copy with it.
    assert.equal((await uninstallAgentStateReporter(world.root, claudeSpec)).ok, true)
    const after = await readStatusLine(world)
    assert.equal(after.statusLine, undefined, 'a status line that wrapped nothing must be deleted')
    assert.deepEqual(after.permissions, { allow: ['Bash(ls:*)'] }, 'uninstall must keep unrelated keys')
    assert.ok(!existsSync(join(world.root, '.multicode', 'hooks', 'status-line.mjs')), 'forwarder copy survived uninstall')
  }

  // 2. A user-level status line is wrapped, its padding carried, and it is NOT
  //    copied back into the project file on uninstall: it still lives in
  //    ~/.claude/settings.json, and a duplicate here would shadow every later
  //    edit of the original.
  {
    const theirs = { type: 'command', command: 'my-line.sh --pretty', padding: 2, refreshInterval: 5 }
    const world = await seedStatusLineWorld({ user: { statusLine: theirs } })
    assert.equal((await installStatusLine(world)).ok, true)
    let settings = await readStatusLine(world)
    assert.deepEqual(settings.statusLine._multicodeWrapped, theirs, 'the original must be kept verbatim')
    assert.equal(settings.statusLine._multicodeWrappedFrom, 'user')
    assert.equal(settings.statusLine.padding, 2, 'padding must be carried so the layout does not move')
    assert.equal(settings.statusLine.refreshInterval, 5, 'refreshInterval must be carried: their script still prints')
    assert.deepEqual(wrapArgOf(settings.statusLine.command), { command: 'my-line.sh --pretty' })

    // Idempotent: a second install unwraps our own entry rather than wrapping
    // itself, and rewrites the identical bytes.
    const first = await readFile(world.settingsPath, 'utf8')
    assert.equal((await installStatusLine(world)).ok, true)
    assert.equal(await readFile(world.settingsPath, 'utf8'), first, 'a second install must be byte-identical')

    assert.equal((await uninstallAgentStateReporter(world.root, claudeSpec)).ok, true)
    settings = await readStatusLine(world)
    assert.equal(settings.statusLine, undefined, 'a user-level original must not be re-homed into the project file')
    const userSettings = JSON.parse(await readFile(join(world.home, '.claude', 'settings.json'), 'utf8'))
    assert.deepEqual(userSettings.statusLine, theirs, 'the user settings file must never be touched')
  }

  // 3. A project-level status line beats the user-level one, and a status line
  //    the person had in settings.local.json itself IS restored there.
  {
    const project = { type: 'command', command: 'project-line.sh' }
    const world = await seedStatusLineWorld({
      project: { statusLine: project },
      user: { statusLine: { type: 'command', command: 'user-line.sh' } },
    })
    assert.equal((await installStatusLine(world)).ok, true)
    const settings = await readStatusLine(world)
    assert.deepEqual(settings.statusLine._multicodeWrapped, project, 'project settings outrank user settings')
    assert.equal(settings.statusLine._multicodeWrappedFrom, 'project')
  }
  {
    const mine = { type: 'command', command: 'local-line.sh', padding: 1 }
    const world = await seedStatusLineWorld({ local: { statusLine: mine, env: { FOO: 'bar' } } })
    assert.equal((await installStatusLine(world)).ok, true)
    let settings = await readStatusLine(world)
    assert.equal(settings.statusLine._multicodeWrappedFrom, 'local')
    assert.deepEqual(wrapArgOf(settings.statusLine.command), { command: 'local-line.sh' })
    assert.equal((await uninstallAgentStateReporter(world.root, claudeSpec)).ok, true)
    settings = await readStatusLine(world)
    assert.deepEqual(settings.statusLine, mine, 'a local original must come back exactly as it was')
    assert.deepEqual(settings.env, { FOO: 'bar' }, 'uninstall must keep unrelated keys')
  }

  // 4. CLAUDE_CONFIG_DIR redirects the user-level read (first comma entry), the
  //    same rule every other Claude reader in this app follows.
  {
    const world = await seedStatusLineWorld({ user: { statusLine: { type: 'command', command: 'home-line.sh' } } })
    const altConfig = join(world.home, 'alt-config')
    await mkdir(altConfig, { recursive: true })
    await writeFile(
      join(altConfig, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'alt-line.sh' } }),
      'utf8'
    )
    assert.equal((await installStatusLine(world, { CLAUDE_CONFIG_DIR: `${altConfig},/other` })).ok, true)
    const settings = await readStatusLine(world)
    assert.deepEqual(wrapArgOf(settings.statusLine.command), { command: 'alt-line.sh' })
  }

  // 5. A spec that does not opt in installs no status line at all, and a build
  //    missing the forwarder still installs the hooks.
  {
    const world = await seedStatusLineWorld({})
    const optedOut: PluginAgentStateSpec = { ...claudeSpec, statusLine: false }
    assert.equal((await installAgentStateReporter(world.root, optedOut, {
      sourceScriptPath,
      socketPath: world.socket,
      statusLineScriptPath: statusLineScript,
      homeDir: world.home,
      env: {},
    })).ok, true)
    assert.equal((await readStatusLine(world)).statusLine, undefined)

    const world2 = await seedStatusLineWorld({})
    assert.equal((await installAgentStateReporter(world2.root, claudeSpec, {
      sourceScriptPath,
      socketPath: world2.socket,
      statusLineScriptPath: join(world2.root, 'does-not-exist.mjs'),
      homeDir: world2.home,
      env: {},
    })).ok, true, 'a missing forwarder must not fail the agent-state install')
    const settings2 = await readStatusLine(world2)
    assert.equal(settings2.statusLine, undefined)
    assert.ok(settings2.hooks?.SessionStart, 'hooks must still be installed without the forwarder')
  }

  // 6. A status line we cannot run on their behalf is never DISPLACED. The type
  //    below is what a future Claude release looks like from here, and the whole
  //    point is that we must not delete a setting we merely failed to recognize
  //    — so no status line of ours is installed at all, in the file we write or
  //    in the ones we only read.
  {
    const odd = { type: 'something-else', command: 'x' }
    const world = await seedStatusLineWorld({ project: { statusLine: odd } })
    assert.equal((await installStatusLine(world)).ok, true)
    const settings = await readStatusLine(world)
    assert.equal(settings.statusLine, undefined, 'an unwrappable status line stops the install')
    assert.ok(settings.hooks?.SessionStart, 'and the hooks still land — they are the load-bearing half')
    const projectSettings = JSON.parse(await readFile(join(world.root, '.claude', 'settings.json'), 'utf8'))
    assert.deepEqual(projectSettings.statusLine, odd, 'the project settings file must never be touched')
  }
  {
    // …and in the file we DO write, where overwriting it would be unrecoverable.
    for (const theirs of [
      { command: 'no-type.sh' },
      { type: 'static', text: 'hello' },
      { type: 'command', command: 'x'.repeat(9000) },
    ]) {
      const world = await seedStatusLineWorld({ local: { statusLine: theirs, env: { KEEP: 'me' } } })
      assert.equal((await installStatusLine(world)).ok, true)
      const settings = await readStatusLine(world)
      assert.deepEqual(settings.statusLine, theirs, `an unwrappable local status line survives: ${JSON.stringify(theirs)}`)
      assert.deepEqual(settings.env, { KEEP: 'me' })
      assert.ok(settings.hooks?.SessionStart)
    }
  }

  // 7. A writer that round-trips settings.local.json through a schema dropping
  //    unknown keys takes `_multicode` and the wrap bookkeeping with it. The
  //    command it leaves behind still carries the person's own command, base64'd
  //    in --wrap, and that is then the only copy of it left anywhere.
  {
    const theirs = { type: 'command', command: 'stripped-original.sh' }
    const world = await seedStatusLineWorld({ local: { statusLine: theirs } })
    assert.equal((await installStatusLine(world)).ok, true)
    const installed = await readStatusLine(world)
    assert.deepEqual(wrapArgOf(installed.statusLine.command), { command: 'stripped-original.sh' })

    const stripped = { type: 'command', command: installed.statusLine.command }
    await writeFile(world.settingsPath, JSON.stringify({ ...installed, statusLine: stripped }, null, 2), 'utf8')
    assert.equal((await installStatusLine(world)).ok, true)
    const healed = await readStatusLine(world)
    assert.deepEqual(
      healed.statusLine._multicodeWrapped,
      theirs,
      'the wrapped command is recovered from our own argv when the bookkeeping is gone'
    )
    assert.deepEqual(wrapArgOf(healed.statusLine.command), { command: 'stripped-original.sh' })
    // Origin is genuinely unrecoverable, so it is treated as local — the
    // direction that keeps a command running.
    assert.equal(healed.statusLine._multicodeWrappedFrom, 'local')

    // And uninstall recovers it the same way. This is the case that loses the
    // command outright if only install knows the trick.
    await writeFile(world.settingsPath, JSON.stringify({ ...installed, statusLine: stripped }, null, 2), 'utf8')
    assert.equal((await uninstallAgentStateReporter(world.root, claudeSpec)).ok, true)
    assert.deepEqual(
      (await readStatusLine(world)).statusLine,
      theirs,
      'uninstall recovers a stripped original from our own argv rather than deleting it'
    )
  }
  {
    // A stripped entry outranks every file below it, so what it carries is what
    // Claude was running. A lower-precedence file must not take its place — that
    // would run a command Claude never would have AND throw away the only copy
    // of the one it did.
    const mine = { type: 'command', command: 'local-mine.sh' }
    const world = await seedStatusLineWorld({
      local: { statusLine: mine },
      user: { statusLine: { type: 'command', command: 'user-other.sh' } },
    })
    assert.equal((await installStatusLine(world)).ok, true)
    const installed = await readStatusLine(world)
    await writeFile(
      world.settingsPath,
      JSON.stringify({ ...installed, statusLine: { type: 'command', command: installed.statusLine.command } }, null, 2),
      'utf8'
    )
    assert.equal((await installStatusLine(world)).ok, true)
    assert.deepEqual(
      wrapArgOf((await readStatusLine(world)).statusLine.command),
      { command: 'local-mine.sh' },
      'the recovered local command outranks a live user one'
    )
  }
  {
    // A `_multicodeWrapped` that is no longer something we could wrap (a
    // hand-edit, a type from a later Claude) is still the record uninstall
    // restores from: leave the whole setting alone rather than overwrite it
    // with null.
    const odd = { type: 'command' }
    const world = await seedStatusLineWorld({ local: { statusLine: { type: 'command', command: 'mine.sh' } } })
    assert.equal((await installStatusLine(world)).ok, true)
    const installed = await readStatusLine(world)
    const tampered = { ...installed.statusLine, _multicodeWrapped: odd }
    await writeFile(world.settingsPath, JSON.stringify({ ...installed, statusLine: tampered }, null, 2), 'utf8')
    assert.equal((await installStatusLine(world)).ok, true)
    assert.deepEqual(
      (await readStatusLine(world)).statusLine._multicodeWrapped,
      odd,
      'a restore record we cannot re-wrap is never overwritten'
    )
    assert.equal((await uninstallAgentStateReporter(world.root, claudeSpec)).ok, true)
    assert.deepEqual((await readStatusLine(world)).statusLine, odd, 'and it is still what comes back')
  }
  {
    // The other side of "never displace what we cannot run": a status line the
    // person adds AFTER we installed, in a file ours outranks. Ours would shadow
    // it silently and forever, so ours comes out.
    const world = await seedStatusLineWorld({ user: { statusLine: { type: 'command', command: 'user-line.sh' } } })
    assert.equal((await installStatusLine(world)).ok, true)
    assert.equal((await readStatusLine(world)).statusLine._multicode, true)
    await writeFile(
      join(world.root, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'from-a-later-claude' } }),
      'utf8'
    )
    assert.equal((await installStatusLine(world)).ok, true)
    assert.equal(
      (await readStatusLine(world)).statusLine,
      undefined,
      'ours steps out of the way rather than shadow a status line it cannot run'
    )
  }
  {
    // The rendered command has its own ceiling (cmd.exe stops at 8191): a
    // command well inside the source cap can still render past it once the
    // base64 envelope and the JSON escaping of every quote are counted.
    const long = { type: 'command', command: 'echo ' + '"'.repeat(3500) }
    const world = await seedStatusLineWorld({ local: { statusLine: long } })
    assert.equal((await installStatusLine(world)).ok, true)
    assert.deepEqual(
      (await readStatusLine(world)).statusLine,
      long,
      'a command that would render past the platform limit is left exactly where it is'
    )
  }

  // 8. A project or user status line EDITED after we wrapped it: the snapshot we
  //    hold is only "what to run" (uninstall never re-homes those), so the live
  //    file wins. Otherwise the first version they ever wrote would run forever.
  {
    const world = await seedStatusLineWorld({ project: { statusLine: { type: 'command', command: 'v1.sh' } } })
    assert.equal((await installStatusLine(world)).ok, true)
    assert.deepEqual(wrapArgOf((await readStatusLine(world)).statusLine.command), { command: 'v1.sh' })

    await writeFile(
      join(world.root, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'v2.sh' } }),
      'utf8'
    )
    assert.equal((await installStatusLine(world)).ok, true)
    assert.deepEqual(
      wrapArgOf((await readStatusLine(world)).statusLine.command),
      { command: 'v2.sh' },
      'the live project settings win over the snapshot we displaced'
    )

    // And deleting it there means they meant to delete it.
    await writeFile(join(world.root, '.claude', 'settings.json'), JSON.stringify({}), 'utf8')
    assert.equal((await installStatusLine(world)).ok, true)
    const after = await readStatusLine(world)
    assert.equal(after.statusLine._multicodeWrapped, null)
    assert.ok(!after.statusLine.command.includes('--wrap'))
  }

  // 9. A status line that cannot be installed must never cost the workspace its
  //    agent state: the hooks are the load-bearing half. A directory sitting
  //    where the forwarder copy goes makes the copy throw.
  {
    const world = await seedStatusLineWorld({})
    await mkdir(join(world.root, '.multicode', 'hooks', 'status-line.mjs'), { recursive: true })
    const result = await installStatusLine(world)
    assert.equal(result.ok, true, `a status-line failure must not fail the install: ${JSON.stringify(result)}`)
    const settings = await readStatusLine(world)
    assert.ok(settings.hooks?.SessionStart, 'the hooks landed')
    assert.equal(settings.statusLine, undefined, 'and no half-installed status line was written')
  }

  // 10. Only numbers are carried across; the rest of the person's object stays
  //     in `_multicodeWrapped` and comes back on uninstall.
  {
    const theirs = { type: 'command', command: 'l.sh', padding: 'two', refreshInterval: null, colour: 'red' }
    const world = await seedStatusLineWorld({ local: { statusLine: theirs } })
    assert.equal((await installStatusLine(world)).ok, true)
    const settings = await readStatusLine(world)
    assert.ok(!('padding' in settings.statusLine), 'a non-numeric padding is not carried')
    assert.ok(!('refreshInterval' in settings.statusLine), 'nor a null refreshInterval')
    assert.deepEqual(settings.statusLine._multicodeWrapped, theirs, 'but the whole object is kept for the restore')
    assert.equal((await uninstallAgentStateReporter(world.root, claudeSpec)).ok, true)
    assert.deepEqual((await readStatusLine(world)).statusLine, theirs)
  }

  // 10b. The command we WRITE is executed by Claude through a shell. Take it
  //      out of the file and run it, with a wrapped command built to break out
  //      of any encoding that is not opaque, and check that the person's own
  //      command is what ran — argument for argument — and nothing else.
  if (process.platform !== 'win32') {
    const marker = join(await mkdtemp(join(tmpdir(), 'agent-state-sl-shell-')), 'pwned')
    const theirs = {
      type: 'command',
      command: `printf '%s' 'quoted "and" $HOME'; test -e ${JSON.stringify(marker)} && printf ' PWNED'`,
    }
    const world = await seedStatusLineWorld({ local: { statusLine: theirs } })
    assert.equal((await installStatusLine(world)).ok, true)
    const written = (await readStatusLine(world)).statusLine.command as string
    const out = await new Promise<string>((res, rej) => {
      const child = spawn('/bin/sh', ['-c', written], {
        env: { ...process.env, MULTICODE_AGENT_ID: '', MULTICODE_AGENT_STATE_SOCKET: '', SHELL: '/bin/sh' },
        stdio: ['pipe', 'pipe', 'ignore'],
      })
      let stdout = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.on('error', rej)
      child.on('close', () => res(stdout))
      child.stdin.end(JSON.stringify({ session_id: 's', context_window: { used_percentage: 4 } }))
    })
    assert.equal(
      out,
      'quoted "and" $HOME',
      'the settings command runs the person’s own command verbatim, and nothing of ours is interpreted'
    )
    assert.ok(!existsSync(marker), 'nothing in the wrapped command escaped into our own command line')
  }

  // 11. A malformed user settings file must not take the install down with it.
  {
    const world = await seedStatusLineWorld({})
    await writeFile(join(world.home, '.claude', 'settings.json'), '{ "statusLine": ', 'utf8')
    assert.equal((await installStatusLine(world)).ok, true, 'unreadable user settings must not fail the install')
    assert.equal((await readStatusLine(world)).statusLine._multicodeWrapped, null)
  }

  // 12. Someone replaced our status line by hand: uninstall leaves it exactly so.
  {
    const world = await seedStatusLineWorld({ local: { statusLine: { type: 'command', command: 'theirs.sh' } } })
    assert.equal((await uninstallAgentStateReporter(world.root, claudeSpec)).ok, true)
    assert.deepEqual((await readStatusLine(world)).statusLine, { type: 'command', command: 'theirs.sh' })
  }

  console.log('agent-state.test.ts: all assertions passed')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
