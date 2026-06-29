import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import {
  AGENT_STATE_CODEX_HOOK_EVENTS,
  AGENT_STATE_HOOK_EVENTS,
  AGENT_STATE_HOOK_TAG,
  buildAgentStateReporterCommand,
  deriveActivityFromPhase,
  evaluateAgentStall,
  installAgentStateHook,
  installCodexAgentStateHook,
  isAuthoritativeWorkingPhase,
  mapHookEventToPhase,
  mergeCodexAgentStateHooks,
  mergeAgentStateHooks,
  parseAgentStateFrame,
  renderCodexAgentStateHooksBlock,
  selectAgentStateTarget,
  uninstallAgentStateHook,
  uninstallCodexAgentStateHook,
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

async function run(): Promise<void> {
  // --- event → phase mapping ---------------------------------------------
  assert.equal(mapHookEventToPhase('SessionStart'), 'starting')
  assert.equal(mapHookEventToPhase('UserPromptSubmit'), 'thinking')
  assert.equal(mapHookEventToPhase('PreToolUse'), 'tool_use')
  assert.equal(mapHookEventToPhase('PostToolUse'), 'thinking')
  assert.equal(mapHookEventToPhase('Notification'), 'awaiting_input')
  assert.equal(mapHookEventToPhase('PermissionRequest'), 'awaiting_input')
  assert.equal(mapHookEventToPhase('Stop'), 'idle')
  assert.equal(mapHookEventToPhase('SubagentStop'), 'idle')
  assert.equal(mapHookEventToPhase('SessionEnd'), 'exited')
  assert.equal(mapHookEventToPhase('NotAnEvent'), null)

  // --- Notification notification_type discrimination ----------------------
  // Informational notifications (esp. the idle "waiting for your input" nudge)
  // must NOT report awaiting_input — that was the false attention-glyph bug.
  assert.equal(mapHookEventToPhase('Notification', 'idle_prompt'), null)
  assert.equal(mapHookEventToPhase('Notification', 'auth_success'), null)
  assert.equal(mapHookEventToPhase('Notification', 'elicitation_complete'), null)
  assert.equal(mapHookEventToPhase('Notification', 'elicitation_response'), null)
  // Real prompts (and unknown/absent types, conservatively) stay awaiting_input.
  assert.equal(mapHookEventToPhase('Notification', 'permission_prompt'), 'awaiting_input')
  assert.equal(mapHookEventToPhase('Notification', 'elicitation_dialog'), 'awaiting_input')
  assert.equal(mapHookEventToPhase('Notification', 'some_future_type'), 'awaiting_input')
  assert.equal(mapHookEventToPhase('Notification', null), 'awaiting_input')
  assert.equal(mapHookEventToPhase('Notification', undefined), 'awaiting_input')
  // notification_type is only consulted for Notification.
  assert.equal(mapHookEventToPhase('PermissionRequest', 'idle_prompt'), 'awaiting_input')

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
  // ts defaults to `now` when absent or non-finite.
  assert.equal(parseAgentStateFrame({ type: 'agent_state', agentId: 'a1', phase: 'idle' }, 999)?.ts, 999)
  // rejects: wrong type, missing agentId, bad phase, non-object.
  assert.equal(parseAgentStateFrame({ type: 'other', agentId: 'a1', phase: 'idle' }, 1), null)
  assert.equal(parseAgentStateFrame({ type: 'agent_state', phase: 'idle' }, 1), null)
  assert.equal(parseAgentStateFrame({ type: 'agent_state', agentId: 'a1', phase: 'nope' }, 1), null)
  assert.equal(parseAgentStateFrame('not-json-object', 1), null)
  assert.equal(parseAgentStateFrame(null, 1), null)

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
  // Inferred or non-working phases never stall.
  assert.deepEqual(evaluateAgentStall({ ...stallBase, phase: 'tool_use', source: 'inferred' }), { action: 'clear' })
  assert.deepEqual(evaluateAgentStall({ ...stallBase, phase: 'idle', source: 'hook' }), { action: 'clear' })
  assert.deepEqual(evaluateAgentStall({ ...stallBase, phase: 'awaiting_input', source: 'hook' }), { action: 'clear' })
  // Working + quiet past the threshold → stalled.
  assert.deepEqual(evaluateAgentStall({ ...stallBase, phase: 'tool_use', source: 'hook' }), { action: 'stalled' })
  assert.deepEqual(evaluateAgentStall({ ...stallBase, phase: 'thinking', source: 'hook' }), { action: 'stalled' })
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

  // --- heuristic cutover guard --------------------------------------------
  // Only a hook-driven working phase suppresses the legacy idle-timer flip.
  assert.equal(isAuthoritativeWorkingPhase({ phase: 'tool_use', since: 1, source: 'hook' }), true)
  assert.equal(isAuthoritativeWorkingPhase({ phase: 'thinking', since: 1, source: 'hook' }), true)
  assert.equal(isAuthoritativeWorkingPhase({ phase: 'awaiting_input', since: 1, source: 'hook' }), false)
  assert.equal(isAuthoritativeWorkingPhase({ phase: 'idle', since: 1, source: 'hook' }), false)
  // Inferred working never suppresses (no hook to trust), nor does absent state.
  assert.equal(isAuthoritativeWorkingPhase({ phase: 'thinking', since: 1, source: 'inferred' }), false)
  assert.equal(isAuthoritativeWorkingPhase(undefined), false)

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

  // --- install / uninstall round-trip ------------------------------------
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
      PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo user' }] }],
      // A stale Multicode-tagged hook from a prior release that registered the
      // now-dropped PreToolUse event. Install must migrate it away (and uninstall
      // must also clean it), not strand it.
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'old reporter', _multicode: AGENT_STATE_HOOK_TAG }] }],
    } }, null, 2),
    'utf8'
  )

  const installed = await installAgentStateHook(root, { sourceScriptPath, socketPath: join(root, 'agent.sock') })
  assert.equal(installed.ok, true)

  let settings = await readSettings(settingsPath)
  // One entry per registered event.
  assert.equal(countOurEntries(settings), AGENT_STATE_HOOK_EVENTS.length)
  // Every event key is present.
  for (const { event } of AGENT_STATE_HOOK_EVENTS) {
    assert.ok(Array.isArray(settings.hooks?.[event]), `missing event ${event}`)
  }
  // PreToolUse is dropped; PostToolUse is kept (it clears awaiting_input). So we
  // add our own PostToolUse '*' block ALONGSIDE the user's 'Read' block (2 blocks
  // total), and never register PreToolUse.
  assert.equal(settings.hooks?.PreToolUse, undefined, 'PreToolUse must not be registered')
  assert.equal(settings.hooks?.PostToolUse?.length, 2, 'our PostToolUse block must coexist with the user block')
  assert.ok(settings.hooks?.PostToolUse?.some((b) => b.matcher === '*'), 'our PostToolUse * block is missing')
  const userEntry = settings.hooks?.PostToolUse?.find((b) => b.matcher === 'Read')
  assert.ok(userEntry, 'user PostToolUse block dropped')
  assert.equal(userEntry?.hooks?.[0]?.command, 'echo user')

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
  await mergeAgentStateHooks(settingsPath, buildAgentStateReporterCommand(join(root, '.multicode', 'hooks', 'agent-state.mjs'), join(root, 'agent.sock')))
  settings = await readSettings(settingsPath)
  assert.equal(countOurEntries(settings), AGENT_STATE_HOOK_EVENTS.length)

  // Uninstall removes ours, keeps the user's, prunes emptied event keys.
  const removed = await uninstallAgentStateHook(root)
  assert.equal(removed.ok, true)
  settings = await readSettings(settingsPath)
  assert.equal(countOurEntries(settings), 0)
  assert.ok(settings.hooks?.PostToolUse?.some((b) => b.matcher === 'Read'), 'user hook lost on uninstall')
  // SessionStart had only our entry, so the event key is pruned entirely.
  assert.equal(settings.hooks?.SessionStart, undefined)

  // --- Codex (Phase 2): TOML managed-block install ------------------------
  // Render: a single tagged block, one entry per Codex event, command quoted as
  // a TOML basic string, PostToolUse carrying a matcher, and PermissionRequest
  // (Codex's awaiting-input event) present rather than Claude's Notification.
  // PreToolUse is trimmed, so its table is absent.
  const codexBlock = renderCodexAgentStateHooksBlock('node "/abs/agent-state.mjs" --socket "/abs/agent-state.sock"')
  assert.ok(codexBlock.startsWith('# >>> multicode agent-state hooks managed'))
  assert.ok(codexBlock.trimEnd().endsWith('# <<< multicode agent-state hooks managed'))
  assert.ok(codexBlock.includes('[[hooks.PermissionRequest]]'))
  assert.ok(codexBlock.includes('[[hooks.Stop]]'))
  assert.ok(codexBlock.includes('[[hooks.PostToolUse]]') && codexBlock.includes('matcher = "*"'))
  assert.ok(!codexBlock.includes('[[hooks.PreToolUse]]'))
  assert.ok(!codexBlock.includes('Notification'))
  // command is a valid TOML basic string (JSON-escaped quotes).
  assert.ok(codexBlock.includes('command = "node \\"/abs/agent-state.mjs\\" --socket \\"/abs/agent-state.sock\\""'))
  // one [[hooks.<Event>]] table per declared event.
  const tableCount = (codexBlock.match(/^\[\[hooks\.[A-Za-z]+\]\]$/gmu) ?? []).length
  assert.equal(tableCount, AGENT_STATE_CODEX_HOOK_EVENTS.length)

  // Merge preserves surrounding user config and is idempotent.
  const userToml = 'model = "gpt-5-codex"\n\n[mcp_servers.foo]\ncommand = "foo"\n'
  const mergedOnce = mergeCodexAgentStateHooks(userToml, 'node "/x.mjs" --socket "/s.sock"')
  assert.ok(mergedOnce.includes('model = "gpt-5-codex"'), 'user config dropped')
  assert.ok(mergedOnce.includes('[mcp_servers.foo]'), 'user MCP block dropped')
  const mergedTwice = mergeCodexAgentStateHooks(mergedOnce, 'node "/x.mjs" --socket "/s.sock"')
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

  const codexInstalled = await installCodexAgentStateHook(codexRoot, {
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

  const codexRemoved = await uninstallCodexAgentStateHook(codexRoot)
  assert.equal(codexRemoved.ok, true)
  codexConfig = await readFile(join(codexRoot, '.codex', 'config.toml'), 'utf8')
  assert.ok(codexConfig.includes('approval_policy = "on-request"'), 'uninstall dropped user config')
  assert.ok(!codexConfig.includes('[[hooks.SessionStart]]'), 'uninstall left the hooks block')

  console.log('agent-state.test.ts: all assertions passed')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
