import assert from 'node:assert/strict'
import { join } from 'node:path'

import { applyDebugDirective, debugDirectiveFor } from '../shared/debug-directive'

// The directive names the workspace's own sidecar directory, so the expected
// text is derived the same way the launch derives it rather than pinned.
const DEBUG_DIRECTIVE = debugDirectiveFor()
import type { SprintEngineCliPermissionPreset } from '../shared/electron-api'
import {
  argvToPosixShellCommand,
  buildAgentShellCommand,
  cliCredentialLaunchBlock,
  pluginIdForCli,
  quotePosixToken,
  renderAgentLaunchArgv,
  renderAgentLaunchPreview,
  resolveCliRuntimeSettings,
  resolveDebugSkillInvocation,
} from './agent-launch-render'
import { composeSpawnAgentPrompt } from './automations/actions/spawn-agent'
import { createPluginRegistry } from './plugin-registry'
import { buildCodexLegacyNativeAgentLaunchPowerShellScript } from './terminal-launch'
import {
  __resetPluginRegistryForTest,
  __setPluginRegistryForTest,
  getPluginById,
} from './plugin-registry-instance'

// The CLI-native debug skill invocation each bundled manifest declares via
// skillIntegration.invocation.explicitTemplate, rendered for skillId "debug".
const DEBUG_INVOCATION: Record<'claude-code' | 'codex', string> = {
  'claude-code': '/debug',
  codex: 'Use $debug.',
}

const BUNDLED_ROOT = join(process.cwd(), 'resources', 'plugins')

async function main(): Promise<void> {
  await usingBundledRegistry(async () => {
    testPluginCliMapping()
    testClaudeCodeRenderDefault()
    testClaudeCodeRenderWithBypass()
    testClaudeCodeRenderResume()
    testClaudeCodeRenderWithRuntimeBinaryOverride()
    testLaunchExecutesProbedPathAndGuardFailsHard()
    testCodexRenderDefault()
    testCodexRenderWithAutoWorkspace()
    testCodexRenderResume()
    testOpenCodeRenderDefault()
    testOpenCodeRenderWithBypassAndModel()
    testOpenCodeRenderResume()
    testClaudeCodeRenderWithModel()
    testCodexRenderWithModel()
    testOrdinaryCliRendersNoLaunchEnv()
    testZaiRenderInjectsLaunchEnv()
    testZaiRenderOmitsModelFlag()
    testKimiClaudeRenderInjectsLaunchEnv()
    testCodexRenderWithReasoning()
    testClaudeCodeRenderWithReasoning()
    testUndeclaredCliRendersNoReasoning()
    testCodexLegacyWindowsReasoning()
    testCliCredentialLaunchBlock()
    testQuoteTokenLeavesSafeStringsBare()
    testQuoteTokenWrapsSpecialChars()
    testArgvToPosixShellCommand()
    testBuildAgentShellCommandClaudeCode()
    testBuildAgentShellCommandCodex()
    testRenderArgvIncludesBinaryAsFirstElement()
    testResolveCliRuntimeSettings()
    testApplyDebugDirectiveHelper()
    testResolveDebugSkillInvocation()
    testDebugModeOrthogonality()
    testDebugDirectiveReachesRenderedArgvAllPaths()
    testCodexLegacyWindowsDebugInjection()
    testLaunchPreviewMatchesTheLaunchItPreviews()
    testLaunchPreviewCarriesEveryControlOnTheRow()
    testNoHostContextRendersNothingAnywhere()
    testClaudeCodeTakesTheContextFileOnLaunchAndResume()
    testCodexTakesTheContextAsAnEscapedTomlOverride()
    testGrokTakesTheContextTextOnLaunchAndResume()
    testOpenCodeTakesTheContextThroughItsConfigEnv()
    testPromptFallbackCliRendersNoContextFlag()
    testCursorTakesTheContextAsAPluginDirOnLaunchAndResume()
    testAModuleHostContextSectionRidesTheDeclaredChannel()
    testLaunchPreviewNeverShowsHostContext()
    testLaunchPluginDirsReachLaunchAndResume()
    testLaunchSettingsReachLaunchAndResume()
  })

  console.log('agent-launch-render tests passed')
}

async function usingBundledRegistry(fn: () => Promise<void> | void): Promise<void> {
  __resetPluginRegistryForTest()
  const registry = createPluginRegistry({
    bundledRoot: BUNDLED_ROOT,
    userRoot: join(process.cwd(), '.does-not-exist', 'multicode', 'plugins'),
  })
  const report = registry.loadSync()
  assert.deepEqual(
    report.rejected,
    [],
    `bundled manifests should load clean: ${JSON.stringify(report.rejected, null, 2)}`
  )
  __setPluginRegistryForTest(registry, report)
  try {
    await fn()
  } finally {
    __resetPluginRegistryForTest()
  }
}

/** The directories named by a launch's `--plugin-dir` flags, in order. */
function pluginDirFlags(argv: string[]): string[] {
  return argv.flatMap((token, index) => (token === '--plugin-dir' ? [argv[index + 1] ?? ''] : []))
}

// The app's own skills, hook and MCP server reach an agent through the launch,
// for that session only — nothing is written into the person's repository, and
// a CLI started outside this app gets none of it.
function testLaunchPluginDirsReachLaunchAndResume(): void {
  const dirs = ['/data/agent-integration/1.2.3/sprintengine-studio', '/data/agent-integration/1.2.3/studio-skills']

  const launch = renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 's1', pluginDirs: dirs })
  assert.deepEqual(pluginDirFlags(launch.argv), dirs, 'one flag per directory, in order')

  const resumed = renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 's1', resume: true, pluginDirs: dirs })
  assert.deepEqual(pluginDirFlags(resumed.argv), dirs, 'a resumed session is re-told the same plugins')

  // The other CLIs that run the same `claude` binary take the same flag.
  for (const cli of ['kimi-claude', 'zai'] as const) {
    assert.deepEqual(pluginDirFlags(renderAgentLaunchArgv({ cli, sessionId: 's1', pluginDirs: dirs }).argv), dirs, cli)
  }
  // Cursor deliberately declares none, though its CLI has the same flag: the
  // directory this app passes carries Claude's nested PascalCase hooks.json,
  // and Cursor reads a flat camelCase one. Opting it in would load the skills
  // and silently lose its agent state, because the workspace install that
  // writes .cursor/hooks.json would be skipped for a hook it cannot read.
  assert.deepEqual(pluginDirFlags(renderAgentLaunchArgv({ cli: 'cursor', sessionId: 's1', pluginDirs: dirs }).argv), [])

  // Codex declares no `launchPlugins`, so it never sees the flag however many
  // directories the app resolved — its agent state keeps coming from the
  // workspace installer until its own launch-scoped path is verified.
  assert.deepEqual(pluginDirFlags(renderAgentLaunchArgv({ cli: 'codex', sessionId: 's1', pluginDirs: dirs }).argv), [])

  // And an app that has not materialised its copy yet renders the launch it
  // always did — no empty flag, nothing half-passed.
  assert.deepEqual(pluginDirFlags(renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 's1' }).argv), [])
  assert.deepEqual(
    renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 's1' }).argv,
    renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 's1', pluginDirs: [] }).argv
  )
}

// The `--settings` document a launch asked for actually arrives.
//
// This is the regression the render boundary was silently eating: the launch
// path resolved a status line, handed it to `buildAgentShellCommand` in an
// object literal, and `renderAgentLaunchArgv` never copied it onto the render
// context — so every Claude session launched with `--settings {"theme":"…"}`
// and nothing else, and the app stopped learning how full any context window
// was. Nothing failed and nothing in the terminal changed, which is exactly why
// it went unnoticed. TypeScript could not catch it either: a spread in an
// object literal is exempt from excess-property checking.
function settingsDocument(argv: string[]): Record<string, unknown> | null {
  const at = argv.indexOf('--settings')
  if (at < 0) return null
  return JSON.parse(argv[at + 1] ?? 'null') as Record<string, unknown>
}

function testLaunchSettingsReachLaunchAndResume(): void {
  const statusLine = { type: 'command', command: 'node "/data/hooks/status-line.mjs" --socket "/tmp/a.sock"' }

  const launch = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 's1',
    colorScheme: 'dark',
    launchSettings: { statusLine },
  })
  assert.deepEqual(
    settingsDocument(launch.argv),
    { theme: 'dark', statusLine },
    'the status line rides the same --settings document as the theme'
  )
  assert.equal(
    launch.argv.filter((token) => token === '--settings').length,
    1,
    'one --settings, never two: repeating the flag is undocumented'
  )

  const resumed = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 's1',
    resume: true,
    colorScheme: 'dark',
    launchSettings: { statusLine },
  })
  assert.deepEqual(
    settingsDocument(resumed.argv),
    { theme: 'dark', statusLine },
    'a resumed session reports its context usage too'
  )

  // The other CLIs running the same `claude` binary declare the same slot.
  for (const cli of ['kimi-claude', 'zai'] as const) {
    const out = renderAgentLaunchArgv({ cli, sessionId: 's1', launchSettings: { statusLine } })
    assert.deepEqual(settingsDocument(out.argv), { statusLine }, cli)
  }

  // And a launch that resolved none renders exactly the argv it always did.
  assert.deepEqual(
    renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 's1', colorScheme: 'dark', launchSettings: {} }).argv,
    renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 's1', colorScheme: 'dark' }).argv
  )
}

function testPluginCliMapping(): void {
  assert.equal(pluginIdForCli('claude-code'), 'claude-code')
  assert.equal(pluginIdForCli('codex'), 'codex')
}

function testResolveCliRuntimeSettings(): void {
  assert.deepEqual(
    resolveCliRuntimeSettings('claude-code', { 'claude-code': { command: '/opt/claude/bin/claude', useWsl: true } }),
    { command: '/opt/claude/bin/claude', useWsl: true },
    'claude-code launch reads its plugin-id command/WSL override',
  )
  assert.deepEqual(
    resolveCliRuntimeSettings('claude-code', {
      'claude-code': { command: '', useWsl: false },
    }),
    { command: '', useWsl: false },
    'a blank claude-code command means manifest binary at render',
  )
  assert.deepEqual(
    resolveCliRuntimeSettings('codex', undefined),
    { command: '', useWsl: false },
    'no override resolves to a blank command (manifest binary at render)',
  )
}

function testClaudeCodeRenderDefault(): void {
  const out = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 'sid_demo',
  })
  assert.deepEqual(out.argv, ['claude', '--session-id', 'sid_demo'])
  assert.equal(out.binary, 'claude')
}

// The ordinary CLIs declare no `launch.env`, so the rendered env is empty and
// their spawn is byte-for-byte unchanged by the provider-env wire.
function testOrdinaryCliRendersNoLaunchEnv(): void {
  for (const cli of ['claude-code', 'codex', 'opencode'] as const) {
    const out = renderAgentLaunchArgv({ cli, sessionId: 'sid_env' })
    assert.deepEqual(out.env, {}, `${cli} should declare no launch.env`)
  }
}

// The Z.AI runtime runs the `claude` binary redirected at Z.AI's
// Anthropic-compatible endpoint via `launch.env`. The base URL + GLM model map
// are static; the auth token expands from the resolved `{{secret}}`.
function testZaiRenderInjectsLaunchEnv(): void {
  const withToken = renderAgentLaunchArgv({
    cli: 'zai',
    sessionId: 'sid_zai',
    secretToken: 'zai-secret-123',
  })
  assert.equal(withToken.binary, 'claude', 'Z.AI runs the claude binary')
  assert.equal(withToken.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic')
  assert.equal(withToken.env.ANTHROPIC_AUTH_TOKEN, 'zai-secret-123')
  assert.equal(withToken.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-5.2')
  assert.equal(withToken.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.2')
  assert.equal(withToken.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-4.7')

  // With no resolved token, renderEnv drops the empty value so no blank
  // ANTHROPIC_AUTH_TOKEN is injected (the endpoint stays unauthenticated until a
  // key is configured, rather than launching with an empty token).
  const noToken = renderAgentLaunchArgv({ cli: 'zai', sessionId: 'sid_zai2' })
  assert.equal(noToken.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic')
  assert.equal('ANTHROPIC_AUTH_TOKEN' in noToken.env, false, 'no empty token is injected')
}

// Model tier is driven entirely by ANTHROPIC_DEFAULT_*_MODEL env, so the Z.AI
// launch argv must never pass `--model` (which would send a model name to the
// GLM endpoint and bypass the tier mapping).
function testZaiRenderOmitsModelFlag(): void {
  const out = renderAgentLaunchArgv({ cli: 'zai', sessionId: 'sid_zai3', cliModel: 'glm-4.7' })
  assert.equal(out.argv.includes('--model'), false, 'Z.AI argv must not carry --model')
}

// Codex's reasoningSelection renders `-c model_reasoning_effort="…"` only for a
// declared non-default level: the default (medium), an unset level, and an
// undeclared level all leave the argv byte-for-byte unchanged.
function testCodexRenderWithReasoning(): void {
  const high = renderAgentLaunchArgv({ cli: 'codex', sessionId: 'sid_r1', cliReasoning: 'high' })
  assert.deepEqual(high.argv, ['codex', '-c', 'model_reasoning_effort="high"'])

  const atDefault = renderAgentLaunchArgv({ cli: 'codex', sessionId: 'sid_r2', cliReasoning: 'medium' })
  assert.equal(atDefault.argv.includes('-c'), false, 'default level renders no effort flag')

  const unset = renderAgentLaunchArgv({ cli: 'codex', sessionId: 'sid_r3' })
  assert.equal(unset.argv.includes('-c'), false, 'unset level renders no effort flag')

  // `ultra` and `max` are now declared (they exist on gpt-5.6-sol/terra per
  // `codex debug models`), so they render; a level no manifest declares does not.
  const ultra = renderAgentLaunchArgv({ cli: 'codex', sessionId: 'sid_r4', cliReasoning: 'ultra' })
  assert.deepEqual(ultra.argv, ['codex', '-c', 'model_reasoning_effort="ultra"'])
  const bogus = renderAgentLaunchArgv({ cli: 'codex', sessionId: 'sid_r4b', cliReasoning: 'bogus' })
  assert.equal(bogus.argv.includes('-c'), false, 'undeclared level renders no effort flag')

  // Codex's resume argv declares no reasoningArgs spread: the CLI persists the
  // level per session, so re-passing it would clobber a mid-session change.
  const resume = renderAgentLaunchArgv({
    cli: 'codex',
    sessionId: 'sid_r4c',
    resume: true,
    cliReasoning: 'high',
  })
  assert.deepEqual(
    resume.argv,
    renderAgentLaunchArgv({ cli: 'codex', sessionId: 'sid_r4c', resume: true }).argv,
    'codex resume argv does not re-pass the effort level',
  )
}

// claude-code's reasoningSelection (`--effort <level>`, five levels, and
// deliberately NO declared default because the CLI's own default effort is
// undocumented). The argv assertions are what catch the silent no-op this item
// exists to prevent: without the `{"spreadIf": "reasoningArgs"}` entry in its
// launch argv the declaration renders nothing at all.
function testClaudeCodeRenderWithReasoning(): void {
  const high = renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 'sid_cr1', cliReasoning: 'high' })
  assert.deepEqual(
    high.argv,
    ['claude', '--effort', 'high', '--session-id', 'sid_cr1'],
    'a picked level renders --effort, after modelArgs and before the session id',
  )

  // With a model too, both spreads render in manifest order.
  const withModel = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 'sid_cr2',
    cliModel: 'claude-opus-5',
    cliReasoning: 'max',
  })
  assert.deepEqual(withModel.argv, [
    'claude',
    '--model',
    'claude-opus-5',
    '--effort',
    'max',
    '--session-id',
    'sid_cr2',
  ])

  // No declared default means every declared level renders a flag, and only a
  // blank/absent level renders none — the picker's contract.
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const out = renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 'sid_cr3', cliReasoning: level })
    assert.deepEqual(
      out.argv,
      ['claude', '--effort', level, '--session-id', 'sid_cr3'],
      `claude-code renders the declared level ${level}`,
    )
  }

  // An empty or absent level passes no flag, asserted on the rendered argv and
  // byte-compared against the untouched launch.
  const baseline = renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 'sid_cr4' }).argv
  for (const level of [undefined, '', '   ']) {
    assert.deepEqual(
      renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 'sid_cr4', cliReasoning: level }).argv,
      baseline,
      'a blank level leaves the launch argv byte-identical',
    )
  }
  assert.deepEqual(baseline, ['claude', '--session-id', 'sid_cr4'])

  // An undeclared level renders nothing rather than a value the CLI would warn
  // about and ignore.
  assert.deepEqual(
    renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 'sid_cr4', cliReasoning: 'ultra' }).argv,
    baseline,
    'a level claude-code does not declare renders no flag',
  )

  // Resume argv carries no effort: claude-code's resume spec declares no
  // reasoningArgs spread (checked here rather than trusted, since the manifests
  // are inconsistent about which spreads their resume argv repeats).
  assert.deepEqual(
    renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 'sid_cr5',
      resume: true,
      cliReasoning: 'high',
    }).argv,
    ['claude', '--resume', 'sid_cr5'],
    'claude-code resume argv does not re-pass the effort level',
  )
}

// A CLI whose manifest declares no reasoningSelection never renders an effort
// flag, whatever it is handed.
function testUndeclaredCliRendersNoReasoning(): void {
  for (const cli of ['opencode', 'zai'] as const) {
    assert.equal(getPluginById(cli)?.manifest.reasoningSelection, undefined, `${cli} declares no reasoningSelection`)
    const baseline = renderAgentLaunchArgv({ cli, sessionId: 'sid_nr' }).argv
    for (const level of ['high', 'max', 'ultra']) {
      assert.deepEqual(
        renderAgentLaunchArgv({ cli, sessionId: 'sid_nr', cliReasoning: level }).argv,
        baseline,
        `${cli} ignores a reasoning level entirely`,
      )
    }
  }
}

// Kimi K3 via Claude Code runs the `claude` binary redirected at Moonshot's
// Anthropic-compatible endpoint via `launch.env` (the zai pattern). All model
// tiers pin kimi-k3 per Moonshot's Claude Code guide; the auth token expands
// from the resolved `{{secret}}` and is dropped when unconfigured.
function testKimiClaudeRenderInjectsLaunchEnv(): void {
  const withToken = renderAgentLaunchArgv({
    cli: 'kimi-claude',
    sessionId: 'sid_kimi',
    secretToken: 'moonshot-secret-123',
  })
  assert.equal(withToken.binary, 'claude', 'Kimi K3 (Claude Code) runs the claude binary')
  assert.equal(withToken.env.ANTHROPIC_BASE_URL, 'https://api.moonshot.ai/anthropic')
  assert.equal(withToken.env.ANTHROPIC_AUTH_TOKEN, 'moonshot-secret-123')
  assert.equal(withToken.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'kimi-k3')
  assert.equal(withToken.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'kimi-k3')
  assert.equal(withToken.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'kimi-k3')

  const noToken = renderAgentLaunchArgv({ cli: 'kimi-claude', sessionId: 'sid_kimi2' })
  assert.equal(noToken.env.ANTHROPIC_BASE_URL, 'https://api.moonshot.ai/anthropic')
  assert.equal('ANTHROPIC_AUTH_TOKEN' in noToken.env, false, 'no empty token is injected')
}

// A CLI that declares `auth` with no configured key is blocked from launching
// with an actionable message; a configured key or a CLI without auth proceeds.
function testCliCredentialLaunchBlock(): void {
  const blocked = cliCredentialLaunchBlock({
    displayName: 'Z.AI',
    auth: { label: 'Z.AI API key' },
    secretConfigured: false,
  })
  assert.equal(blocked?.message, 'Z.AI needs an API key before it can start. Add it in Settings → Agents.')

  assert.equal(
    cliCredentialLaunchBlock({ displayName: 'Z.AI', auth: { label: 'Z.AI API key' }, secretConfigured: true }),
    null,
    'a configured key proceeds',
  )
  assert.equal(
    cliCredentialLaunchBlock({ displayName: 'Claude Code', secretConfigured: false }),
    null,
    'a CLI without auth never blocks',
  )
}

function testClaudeCodeRenderWithBypass(): void {
  const out = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 'sid_42',
    initialPrompt: 'build the auth flow',
    cliPermissionPreset: 'bypass',
  })
  assert.deepEqual(out.argv, [
    'claude',
    '--permission-mode',
    'bypassPermissions',
    '--session-id',
    'sid_42',
    'build the auth flow',
  ])
}

function testClaudeCodeRenderResume(): void {
  const out = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 'sid_42',
    resume: true,
  })
  assert.deepEqual(out.argv, ['claude', '--resume', 'sid_42'])
}

function testClaudeCodeRenderWithRuntimeBinaryOverride(): void {
  const out = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 'sid_5',
    cliRuntime: { command: '/opt/claude/bin/claude', useWsl: false },
  })
  assert.deepEqual(out.argv, ['/opt/claude/bin/claude', '--session-id', 'sid_5'])
  assert.equal(out.binary, '/opt/claude/bin/claude')
}

function testClaudeCodeRenderWithModel(): void {
  const out = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 'sid_m1',
    cliModel: 'opus',
    cliPermissionPreset: 'bypass',
  })
  assert.deepEqual(out.argv, [
    'claude',
    '--permission-mode',
    'bypassPermissions',
    '--model',
    'opus',
    '--session-id',
    'sid_m1',
  ])

  // Resume must NOT pass --model: Claude Code persists the model per session id,
  // so a resumed session keeps its own model — including a mid-session `/model`
  // switch. Re-passing the spawned-with model here would clobber that change on
  // every reopen. (Verified empirically against claude 2.1.177.)
  const resumed = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 'sid_m1',
    resume: true,
    cliModel: 'opus',
  })
  assert.deepEqual(resumed.argv, ['claude', '--resume', 'sid_m1'])
}

function testCodexRenderWithModel(): void {
  const out = renderAgentLaunchArgv({
    cli: 'codex',
    sessionId: 'sid_m2',
    cliModel: 'gpt-5-codex',
  })
  assert.deepEqual(out.argv, ['codex', '--model', 'gpt-5-codex'])

  // Resume omits --model, same as Claude Code: the CLI tracks its own session
  // model, so re-passing it would clobber a mid-session switch. This is a
  // per-manifest choice (resume.argv), not engine behavior — a CLI that does NOT
  // persist its session model can keep modelArgs in its own resume.argv. The
  // harness session id IS appended (targeted resume).
  const resumed = renderAgentLaunchArgv({
    cli: 'codex',
    sessionId: 'sid_m2',
    resume: true,
    cliModel: 'gpt-5-codex',
  })
  assert.deepEqual(resumed.argv, ['codex', 'resume', 'sid_m2'])

  // No model selected → manifest renders no model flag at all.
  const noModel = renderAgentLaunchArgv({ cli: 'codex', sessionId: 'sid_m3' })
  assert.deepEqual(noModel.argv, ['codex'])
}

function testCodexRenderDefault(): void {
  const out = renderAgentLaunchArgv({
    cli: 'codex',
    sessionId: 'sid_x',
    initialPrompt: 'fix the parser',
  })
  assert.deepEqual(out.argv, ['codex', 'fix the parser'])
}

function testCodexRenderWithAutoWorkspace(): void {
  const out = renderAgentLaunchArgv({
    cli: 'codex',
    sessionId: 'sid_y',
    initialPrompt: 'fix it',
    cliPermissionPreset: 'auto',
  })
  assert.deepEqual(out.argv, [
    'codex',
    '--ask-for-approval',
    'never',
    '--sandbox',
    'workspace-write',
    'fix it',
  ])
}

function testCodexRenderResume(): void {
  // Targeted resume: a known harness session id is appended so Codex reattaches
  // that specific conversation (`codex resume <id>`).
  const out = renderAgentLaunchArgv({
    cli: 'codex',
    sessionId: 'sid_z',
    resume: true,
  })
  assert.deepEqual(out.argv, ['codex', 'resume', 'sid_z'])

  // Bare fallback: no harness id known yet → plain `codex resume`.
  const bare = renderAgentLaunchArgv({
    cli: 'codex',
    sessionId: '',
    resume: true,
  })
  assert.deepEqual(bare.argv, ['codex', 'resume'])
}

// OpenCode launch: prompt is positional, placed after `run`. The manifest's
// default preset contributes no permission args, so a bare launch is just
// [opencode, run, <prompt>]. Renders against the real loaded opencode manifest.
function testOpenCodeRenderDefault(): void {
  const out = renderAgentLaunchArgv({
    cli: 'opencode',
    sessionId: 'sid_oc',
    initialPrompt: 'fix the parser',
  })
  assert.deepEqual(out.argv, ['opencode', 'run', 'fix the parser'])
  assert.equal(out.binary, 'opencode')
}

// OpenCode bypass + model: the bypass preset adds
// --auto (OpenCode's only permission flag; MC-2214 corrected this from the
// non-existent --dangerously-skip-permissions) and modelSelection adds --model <id>, both
// ahead of the positional prompt (launch.argv order: binary, run,
// permissionArgs, modelArgs, prompt).
function testOpenCodeRenderWithBypassAndModel(): void {
  const out = renderAgentLaunchArgv({
    cli: 'opencode',
    sessionId: 'sid_oc2',
    initialPrompt: 'build the auth flow',
    cliPermissionPreset: 'bypass',
    cliModel: 'anthropic/claude-opus-4',
  })
  assert.deepEqual(out.argv, [
    'opencode',
    'run',
    '--auto',
    '--model',
    'anthropic/claude-opus-4',
    'build the auth flow',
  ])
}

// OpenCode resume: targeted reattach to a known session id via
// `--continue --session <id>`, with the prompt appended positionally. Default
// preset contributes no permission/model args.
function testOpenCodeRenderResume(): void {
  const out = renderAgentLaunchArgv({
    cli: 'opencode',
    sessionId: 'sid_oc3',
    resume: true,
    initialPrompt: 'keep going',
  })
  assert.deepEqual(out.argv, [
    'opencode',
    'run',
    '--continue',
    '--session',
    'sid_oc3',
    'keep going',
  ])
}

function testQuoteTokenLeavesSafeStringsBare(): void {
  assert.equal(quotePosixToken('claude'), 'claude')
  assert.equal(quotePosixToken('--session-id'), '--session-id')
  assert.equal(quotePosixToken('sid_42'), 'sid_42')
  assert.equal(quotePosixToken('/opt/claude/bin/claude'), '/opt/claude/bin/claude')
}

function testQuoteTokenWrapsSpecialChars(): void {
  assert.equal(quotePosixToken('hello world'), `'hello world'`)
  assert.equal(quotePosixToken(`don't`), `'don'"'"'t'`)
  assert.equal(quotePosixToken('a;b'), `'a;b'`)
}

function testArgvToPosixShellCommand(): void {
  const shell = argvToPosixShellCommand([
    'claude',
    '--permission-mode',
    'bypassPermissions',
    '--session-id',
    'sid_42',
    'build the auth flow',
  ])
  assert.equal(
    shell,
    `claude --permission-mode bypassPermissions --session-id sid_42 'build the auth flow'`
  )
}

function testBuildAgentShellCommandClaudeCode(): void {
  const out = buildAgentShellCommand({
    cli: 'claude-code',
    sessionId: 'sid_42',
    initialPrompt: 'hello there',
    cliPermissionPreset: 'bypass',
  })
  assert.equal(
    out,
    `if ! command -v claude >/dev/null 2>&1; then echo 'Claude CLI was not found. Check the claude-code command in Settings.' >&2; exit 127; fi; claude --permission-mode bypassPermissions --session-id sid_42 'hello there'`
  )

  const resumeOut = buildAgentShellCommand({
    cli: 'claude-code',
    sessionId: 'sid_42',
    resume: true,
  })
  assert.equal(
    resumeOut,
    `if ! command -v claude >/dev/null 2>&1; then echo 'Claude CLI was not found. Check the claude-code command in Settings.' >&2; exit 127; fi; claude --resume sid_42`
  )

  // The level survives quoting into the shell command every posix/WSL launch
  // runs — the layer between the rendered argv and the spawned process.
  assert.equal(
    buildAgentShellCommand({ cli: 'claude-code', sessionId: 'sid_43', cliReasoning: 'xhigh' }),
    `if ! command -v claude >/dev/null 2>&1; then echo 'Claude CLI was not found. Check the claude-code command in Settings.' >&2; exit 127; fi; claude --effort xhigh --session-id sid_43`
  )
  assert.equal(
    buildAgentShellCommand({ cli: 'claude-code', sessionId: 'sid_43', resume: true, cliReasoning: 'xhigh' }),
    buildAgentShellCommand({ cli: 'claude-code', sessionId: 'sid_43', resume: true }),
    'the resume shell command carries no effort flag',
  )
}

function testRenderArgvIncludesBinaryAsFirstElement(): void {
  // The PowerShell launch path relies on argv[0] being the binary so it can
  // hand the tail to base64-encoded $arguments. Guard against regressions in
  // the argv shape that would break Windows-native launches for Claude and
  // any future plugin.
  const claude = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 'sid_win',
    initialPrompt: 'do it',
    cliPermissionPreset: 'auto',
  })
  assert.equal(claude.argv[0], 'claude')
  assert.deepEqual(claude.argv.slice(1), [
    '--permission-mode',
    'auto',
    '--session-id',
    'sid_win',
    'do it',
  ])

  const claudeOverride = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 'sid_win',
    cliRuntime: { command: 'C:/tools/claude.exe', useWsl: false },
  })
  assert.equal(claudeOverride.argv[0], 'C:/tools/claude.exe')
  assert.equal(claudeOverride.binary, 'C:/tools/claude.exe')
}

function testBuildAgentShellCommandCodex(): void {
  const out = buildAgentShellCommand({
    cli: 'codex',
    sessionId: 'sid_y',
    initialPrompt: 'fix it',
    cliPermissionPreset: 'auto',
  })
  assert.equal(
    out,
    `if ! command -v codex >/dev/null 2>&1; then echo 'Codex CLI was not found. Check the codex command in Settings.' >&2; exit 127; fi; codex --ask-for-approval never --sandbox workspace-write 'fix it'`
  )

  const resumeOut = buildAgentShellCommand({
    cli: 'codex',
    sessionId: 'sid_y',
    resume: true,
  })
  assert.equal(
    resumeOut,
    `if ! command -v codex >/dev/null 2>&1; then echo 'Codex CLI was not found. Check the codex command in Settings.' >&2; exit 127; fi; codex resume sid_y`
  )
}

// MC-2092. Two halves of the same defect:
//
// 1. The probe resolves an absolute path (it consults the user's interactive
//    shell); the launch shell does not source that config, so it must EXECUTE
//    that path rather than the bare manifest name.
// 2. The guard must exit non-zero. This snippet is joined ahead of an
//    `exec $SHELL -l`, so a guard that echoed and fell through left the user in
//    a bare shell with no agent, while the spawn reported success.
function testLaunchExecutesProbedPathAndGuardFailsHard(): void {
  const resolved = buildAgentShellCommand({
    cli: 'claude-code',
    sessionId: 'sid_probed',
    resolvedBinaryPath: '/Users/dev/.nvm/versions/node/v22.3.0/bin/claude',
  })
  assert.equal(
    resolved,
    `if ! command -v /Users/dev/.nvm/versions/node/v22.3.0/bin/claude >/dev/null 2>&1; then `
      + `echo 'Claude CLI was not found. Check the claude-code command in Settings.' >&2; exit 127; fi; `
      + `/Users/dev/.nvm/versions/node/v22.3.0/bin/claude --session-id sid_probed`,
    'both the guard and the invocation use the probed absolute path',
  )

  // A path with spaces stays one shell word on both sides of the guard.
  const quoted = buildAgentShellCommand({
    cli: 'codex',
    sessionId: 'sid_space',
    resolvedBinaryPath: '/Applications/My Tools/codex',
  })
  assert.ok(
    quoted.startsWith(`if ! command -v '/Applications/My Tools/codex' >/dev/null 2>&1;`),
    `probed path must be quoted in the guard: ${quoted}`,
  )
  assert.ok(quoted.endsWith(`'/Applications/My Tools/codex'`), `probed path must be quoted in the invocation: ${quoted}`)

  // The probe runs against the user's command override, so its resolved path IS
  // that override made absolute and outranks the bare override name.
  assert.equal(
    renderAgentLaunchArgv({
      cli: 'claude-code',
      sessionId: 'sid_both',
      cliRuntime: { command: 'claude', useWsl: false },
      resolvedBinaryPath: '/opt/homebrew/bin/claude',
    }).binary,
    '/opt/homebrew/bin/claude',
  )

  // The guard's failure branch reaches no interactive shell: the launch script
  // appends `exec $SHELL -l` after this snippet, and `exit` ends the script.
  const guardFailure = resolved.slice(0, resolved.indexOf('fi;') + 2)
  assert.ok(/exit 127;\s*fi$/.test(guardFailure), `guard must exit non-zero: ${guardFailure}`)
  assert.ok(!/else/.test(resolved), 'the guard no longer falls through to an else branch')
}

// Criterion: helper returns the prompt unchanged when off and prepends the
// directive when on — led by the CLI-native invocation when one is supplied.
// The pure helper has no plugin/registry deps.
function testApplyDebugDirectiveHelper(): void {
  assert.equal(applyDebugDirective('do the thing', false), 'do the thing', 'off → byte-identical input')
  assert.equal(
    applyDebugDirective('do the thing', true),
    `${DEBUG_DIRECTIVE}\n\ndo the thing`,
    'on, no invocation → directive prepended ahead of the prompt',
  )
  assert.ok(applyDebugDirective('do the thing', true).startsWith(DEBUG_DIRECTIVE), 'directive is first')
  assert.equal(applyDebugDirective('', true), DEBUG_DIRECTIVE, 'on with no prompt → directive only')
  assert.equal(applyDebugDirective('', false), '', 'off with no prompt → empty')

  // With a native invocation: it leads, then the directive, then the prompt.
  assert.equal(
    applyDebugDirective('do the thing', true, '/debug'),
    `/debug\n\n${DEBUG_DIRECTIVE}\n\ndo the thing`,
    'on with invocation → invocation, directive, prompt',
  )
  assert.equal(
    applyDebugDirective('', true, '/debug'),
    `/debug\n\n${DEBUG_DIRECTIVE}`,
    'on with invocation and no prompt → invocation + directive only',
  )
  assert.equal(applyDebugDirective('x', false, '/debug'), 'x', 'off ignores the native invocation')
}

// Criterion: the debug skill invocation is resolved from each bundled manifest's
// skillIntegration.invocation.explicitTemplate, rendered for skillId "debug".
// CLIs without native skill support resolve to undefined (inline-directive
// fallback). Runs inside usingBundledRegistry so the real manifests are loaded.
function testResolveDebugSkillInvocation(): void {
  const claude = getPluginById('claude-code')
  const codex = getPluginById('codex')
  assert.ok(claude && codex, 'bundled claude/codex plugins are loaded')
  assert.equal(resolveDebugSkillInvocation(claude!), '/debug', 'claude resolves the native slash invocation')
  assert.equal(resolveDebugSkillInvocation(codex!), 'Use $debug.', 'codex resolves the native mention invocation')

  // Fallback: a CLI whose plugin does not natively support skills resolves no
  // invocation, so Debug Mode falls back to the inline directive alone. The
  // bundled generic-shell declares skillIntegration.support: 'unsupported'.
  const generic = getPluginById('generic-shell')
  assert.ok(generic, 'bundled generic-shell plugin is loaded')
  assert.equal(
    resolveDebugSkillInvocation(generic!),
    undefined,
    'a non-native CLI resolves no invocation (inline-directive fallback)',
  )
}

// Orthogonality invariant: Debug Mode must change only the prompt token, never
// the permission/session/model argv, for every CLI × preset. The prompt is
// always the trailing argv element, so comparing argv.slice(0, -1) isolates the
// permission surface.
function testDebugModeOrthogonality(): void {
  const presets: SprintEngineCliPermissionPreset[] = ['none', 'manual', 'auto', 'bypass']
  const prompt = 'investigate the crash'
  for (const cli of ['claude-code', 'codex'] as const) {
    for (const preset of presets) {
      const off = renderAgentLaunchArgv({ cli, sessionId: 'sid_dbg', initialPrompt: prompt, cliPermissionPreset: preset })
      const on = renderAgentLaunchArgv({
        cli,
        sessionId: 'sid_dbg',
        initialPrompt: prompt,
        cliPermissionPreset: preset,
        debugMode: true,
      })
      assert.deepEqual(
        on.argv.slice(0, -1),
        off.argv.slice(0, -1),
        `${cli}/${preset}: permission argv identical with debug on vs off`,
      )
      assert.equal(off.argv.at(-1), prompt, `${cli}/${preset}: debug-off prompt token unchanged`)
      assert.equal(
        on.argv.at(-1),
        applyDebugDirective(prompt, true, DEBUG_INVOCATION[cli]),
        `${cli}/${preset}: debug-on prompt token carries the native invocation + directive`,
      )
    }
  }
}

// Criterion: the directive reaches the rendered prompt/argv for all three spawn
// paths. Interactive, automations, and sprintengine startup all compose an
// initial prompt and converge on renderAgentLaunchArgv (the launch boundary), so
// rendering each path's real prompt shape with debugMode proves the directive
// lands regardless of prompt content. buildAgentShellCommand covers the posix/
// wsl shell-string output the same boundary feeds.
function testDebugDirectiveReachesRenderedArgvAllPaths(): void {
  const interactivePrompt = 'investigate the failing login test'
  const automationsPrompt = composeSpawnAgentPrompt({
    userPrompt: 'reproduce the timeout',
    automationId: 'auto-1',
    runId: 'run-1',
  })
  // Representative sprintengine startup shape: leading "Name: Role -" identifier
  // line plus a multiline body (see buildSprintEngineStartupPrompt).
  const sprintenginePrompt = 'Cian Rea: Developer - Your first action is to run the MCP calls.\n\n## First MCP Calls\nCall help.'

  for (const path of [interactivePrompt, automationsPrompt, sprintenginePrompt]) {
    for (const cli of ['claude-code', 'codex'] as const) {
      const out = renderAgentLaunchArgv({ cli, sessionId: 'sid_path', initialPrompt: path, debugMode: true })
      const promptToken = out.argv.at(-1) ?? ''
      assert.ok(promptToken.startsWith(DEBUG_INVOCATION[cli]), `${cli}: native invocation leads for path prompt`)
      assert.ok(promptToken.includes(DEBUG_DIRECTIVE), `${cli}: directive present after the invocation`)
      assert.ok(promptToken.includes(path), `${cli}: original prompt preserved after the directive`)
    }
  }

  const shell = buildAgentShellCommand({
    cli: 'claude-code',
    sessionId: 'sid_path',
    initialPrompt: interactivePrompt,
    cliPermissionPreset: 'bypass',
    debugMode: true,
  })
  // Posix quoting single-quotes the whole prompt token and escapes the
  // apostrophe in the directive, so assert on a quote-free fragment + the state
  // file path rather than the raw directive string.
  assert.ok(shell.includes('You are in DEBUG MODE.'), 'posix/wsl shell command embeds the directive')
  assert.ok(shell.includes('.sprintengine/debug/'), 'directive state-file path reaches the shell command')
  assert.ok(shell.includes('--permission-mode bypassPermissions'), 'permission flags unchanged in shell command')
}

// Decode the base64-wrapped `$arguments = @(...)` line that the Windows-native
// launch scripts emit, so a test can assert on the real argv the codex CLI
// receives rather than on the obfuscated script text. Base64 payloads never
// contain a single quote, so the single-quote delimiter match is unambiguous.
function decodeWindowsScriptArgs(script: string): string[] {
  const argsLine = script.split('\r\n').find((line) => line.startsWith('$arguments = @('))
  assert.ok(argsLine, 'rendered script defines an $arguments array')
  return [...argsLine.matchAll(/FromBase64String\('([^']*)'\)/g)].map(([, b64]) =>
    Buffer.from(b64, 'base64').toString('utf8'),
  )
}

// The codex Windows-native LEGACY path builds argv by hand, so it would silently
// ignore effort unless it renders the level itself. It shares the render rule
// with the manifest paths (renderReasoningArgs), so the level, the declared
// default, and an undeclared level all behave identically to the shared path.
function testCodexLegacyWindowsReasoning(): void {
  const cwd = 'C:/work/repo'
  const runtime = { command: '', useWsl: false }
  const script = (reasoning?: string): string[] =>
    decodeWindowsScriptArgs(
      buildCodexLegacyNativeAgentLaunchPowerShellScript(
        'sid_legacy_r', false, cwd, 'go', runtime, 'manual', 'gpt-5.6-sol', false, reasoning,
      ),
    )

  assert.deepEqual(
    script('high'),
    ['--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="high"', '-C', cwd, 'go'],
    'codex-legacy renders the effort flag after the model flag',
  )
  const baseline = script(undefined)
  assert.deepEqual(baseline, ['--model', 'gpt-5.6-sol', '-C', cwd, 'go'])
  for (const level of [undefined, '', 'medium', 'bogus']) {
    assert.deepEqual(
      script(level),
      baseline,
      `codex-legacy passes no effort flag for ${JSON.stringify(level)}`,
    )
  }

  // Resume re-passes nothing: this path builds one arg list for both launch and
  // resume, so the level has to be suppressed explicitly here (the manifest
  // paths get it for free from codex's resume argv declaring no spread).
  const resumeArgs = (reasoning?: string): string[] =>
    decodeWindowsScriptArgs(
      buildCodexLegacyNativeAgentLaunchPowerShellScript(
        'sid_legacy_r', true, cwd, undefined, runtime, 'manual', 'gpt-5.6-sol', false, reasoning,
      ),
    )
  assert.deepEqual(
    resumeArgs('high'),
    resumeArgs(undefined),
    'codex-legacy resume argv does not re-pass the effort level',
  )
  assert.equal(
    resumeArgs('high').some((arg) => arg.includes('model_reasoning_effort')),
    false,
    'codex-legacy resume argv carries no effort config override',
  )
}

// Criterion R1: the codex Windows-native LEGACY path (codex builds its argv by
// hand outside renderAgentLaunchArgv, so the shared debug boundary does not
// cover it) must (a) carry the verbatim DEBUG_DIRECTIVE into the rendered script
// when debugMode is on, and (b) keep launch/permission args byte-identical with
// debug on vs off — the same orthogonality invariant the shared paths hold.
function testCodexLegacyWindowsDebugInjection(): void {
  const presets: SprintEngineCliPermissionPreset[] = ['none', 'manual', 'auto', 'bypass']
  const cwd = 'C:/work/repo'
  const runtime = { command: '', useWsl: false }
  const prompt = 'investigate the crash'

  for (const preset of presets) {
    const off = buildCodexLegacyNativeAgentLaunchPowerShellScript(
      'sid_legacy', false, cwd, prompt, runtime, preset, 'gpt-5-codex', false,
    )
    const on = buildCodexLegacyNativeAgentLaunchPowerShellScript(
      'sid_legacy', false, cwd, prompt, runtime, preset, 'gpt-5-codex', true,
    )
    const offArgs = decodeWindowsScriptArgs(off)
    const onArgs = decodeWindowsScriptArgs(on)

    // (b) Orthogonality: the prompt is the trailing arg on this path; everything
    // ahead of it (permission flags, model, -C cwd) is identical on vs off.
    assert.deepEqual(
      onArgs.slice(0, -1),
      offArgs.slice(0, -1),
      `codex-legacy/${preset}: permission/launch args identical with debug on vs off`,
    )
    // The non-prompt portion of the script (command resolution, npm-shim block)
    // must be byte-identical too — only the prompt base64 may differ.
    assert.equal(
      on.replace(/\$arguments = @\(.*\)/, ''),
      off.replace(/\$arguments = @\(.*\)/, ''),
      `codex-legacy/${preset}: script body outside $arguments unchanged by debug`,
    )

    // (a) Codex-native invocation leads, directive follows verbatim, ahead of
    // the original prompt. The legacy path escapes newlines/double-quotes in the
    // prompt arg but the invocation and directive text contain neither, so they
    // survive intact.
    assert.equal(offArgs.at(-1), prompt, `codex-legacy/${preset}: debug-off prompt arg unchanged`)
    assert.ok(
      onArgs.at(-1)?.startsWith(DEBUG_INVOCATION.codex),
      `codex-legacy/${preset}: debug-on prompt arg leads with the codex-native invocation`,
    )
    assert.ok(
      onArgs.at(-1)?.includes(DEBUG_DIRECTIVE),
      `codex-legacy/${preset}: directive present after the invocation`,
    )
    assert.ok(
      onArgs.at(-1)?.includes(prompt),
      `codex-legacy/${preset}: original prompt preserved after the directive`,
    )
  }

  // Resume carries no prompt arg on this path, so debug on vs off renders an
  // identical script — the directive only rides an initial prompt.
  const resumeOff = buildCodexLegacyNativeAgentLaunchPowerShellScript(
    'sid_legacy', true, cwd, undefined, runtime, 'manual', undefined, false,
  )
  const resumeOn = buildCodexLegacyNativeAgentLaunchPowerShellScript(
    'sid_legacy', true, cwd, undefined, runtime, 'manual', undefined, true,
  )
  assert.equal(resumeOn, resumeOff, 'codex-legacy resume: debug toggle is a no-op without an initial prompt')

  // Debug on with no initial prompt still injects the codex invocation +
  // directive as the sole prompt arg, matching
  // applyDebugDirective('', true, 'Use $debug.').
  const noPromptOn = buildCodexLegacyNativeAgentLaunchPowerShellScript(
    'sid_legacy', false, cwd, '', runtime, 'manual', undefined, true,
  )
  // This legacy path escapes real newlines to literal "\n" in the codex prompt
  // arg (nativeWindowsCodexPromptArg), so build the expected value by applying
  // the same escaping rather than hardcoding the escaped form.
  const expectedNoPrompt = applyDebugDirective('', true, DEBUG_INVOCATION.codex).replace(/\n/g, '\\n')
  assert.equal(
    decodeWindowsScriptArgs(noPromptOn).at(-1),
    expectedNoPrompt,
    'codex-legacy: debug-on with empty prompt injects the codex invocation + directive (newlines escaped)',
  )
}

// MC-2147: the new-agent tab prints the invocation a spawn WOULD make. The
// value of that line is entirely in it being true, so it is rendered through
// renderAgentLaunchArgv — these two tests are the proof, and they fail the day
// someone reimplements the preview by hand.
function testLaunchPreviewMatchesTheLaunchItPreviews(): void {
  const cases: Array<{ cli: 'claude-code' | 'codex' | 'opencode'; model?: string; preset?: SprintEngineCliPermissionPreset }> = [
    { cli: 'claude-code' },
    { cli: 'claude-code', preset: 'bypass', model: 'claude-opus-5' },
    { cli: 'codex', preset: 'auto' },
    { cli: 'opencode', model: 'anthropic/claude-opus-5' },
  ]

  for (const { cli, model, preset } of cases) {
    const preview = renderAgentLaunchPreview({
      cli,
      cliModel: model,
      cliPermissionPreset: preset,
    })
    // The same inputs through the spawn's own renderer, prompt-free and on the
    // preview's placeholder session, must produce the identical argv.
    const launched = renderAgentLaunchArgv({
      cli,
      sessionId: 'preview',
      cliModel: model,
      cliPermissionPreset: preset,
    })

    assert.deepEqual(
      [preview.binary, ...preview.args],
      launched.argv,
      `${cli}: the preview must BE the launch argv, not a copy of it`,
    )
    assert.equal(
      preview.display,
      argvToPosixShellCommand(launched.argv),
      `${cli}: the display line is the same argv, posix-quoted`,
    )
    assert.equal(preview.args.includes('preview'), preview.args.includes('preview'))
  }
}

// Every control the argument row offers has to reach the line; a control whose
// change leaves the receipt unmoved is a control the user cannot verify.
function testLaunchPreviewCarriesEveryControlOnTheRow(): void {
  const base = renderAgentLaunchPreview({ cli: 'claude-code' })

  const bypassed = renderAgentLaunchPreview({ cli: 'claude-code', cliPermissionPreset: 'bypass' })
  assert.ok(
    bypassed.args.includes('--permission-mode') && bypassed.args.includes('bypassPermissions'),
    'approval reaches the line as the flag it becomes',
  )
  assert.notEqual(base.display, bypassed.display, 'changing approval moves the line')

  const withModel = renderAgentLaunchPreview({ cli: 'claude-code', cliModel: 'claude-opus-5' })
  assert.ok(withModel.args.includes('--model') && withModel.args.includes('claude-opus-5'), 'model reaches the line')

  const withReasoning = renderAgentLaunchPreview({
    cli: 'claude-code',
    cliModel: 'claude-opus-5',
    cliReasoning: 'high',
  })
  assert.notEqual(withModel.display, withReasoning.display, 'reasoning moves the line on a CLI that declares levels')

  // Debug is a prompt directive, never a flag (the orthogonality invariant this
  // file already pins), so the preview has no debug knob at all: with the prompt
  // withheld, a debug launch and an ordinary one differ only in the prompt token.
  const debugArgv = renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 'preview', debugMode: true })
  const plainArgv = renderAgentLaunchArgv({ cli: 'claude-code', sessionId: 'preview', debugMode: false })
  assert.deepEqual(
    debugArgv.argv.filter((token) => !token.includes(DEBUG_DIRECTIVE)),
    plainArgv.argv,
    'debug mode adds a prompt token and moves no flag — which is why the receipt omits it',
  )
  assert.equal(base.display, renderAgentLaunchPreview({ cli: 'claude-code' }).display, 'the preview is stable')

  // The runtime override is what actually gets executed, so it is what shows.
  const overridden = renderAgentLaunchPreview({
    cli: 'claude-code',
    cliRuntime: { command: '/opt/homebrew/bin/claude', useWsl: false },
  })
  assert.equal(overridden.binary, '/opt/homebrew/bin/claude', 'the receipt names the binary that will run')
}

// ── Host context ────────────────────────────────────────────────────────────
//
// One document, delivered per the manifest's `contextInjection`. These run
// against the BUNDLED manifests through the same renderer every spawn uses, so a
// manifest edit that broke a channel fails here rather than in a real session.

const HOST_CONTEXT_FILE = '/ctx/sid.md'
const HOST_CONTEXT_TEXT = 'Host context.\nA design system is attached at `design-system/`.'

// A launch with nothing to say renders no flag and no env, on every CLI. This is
// the invariant that keeps an ordinary repo's spawn byte-identical.
function testNoHostContextRendersNothingAnywhere(): void {
  for (const cli of ['claude-code', 'codex', 'grok', 'opencode', 'cursor'] as const) {
    const out = renderAgentLaunchArgv({ cli, sessionId: 'sid_none' })
    assert.ok(!out.argv.includes('--append-system-prompt-file'), cli)
    assert.ok(!out.argv.includes('--append-system-prompt'), cli)
    assert.ok(!out.argv.includes('--plugin-dir'), cli)
    assert.ok(!out.argv.some((arg) => arg.startsWith('developer_instructions=')), cli)
    assert.equal('OPENCODE_CONFIG_CONTENT' in out.env, false, cli)
  }
}

function testClaudeCodeTakesTheContextFileOnLaunchAndResume(): void {
  const launch = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 'sid_ctx',
    contextFile: HOST_CONTEXT_FILE,
    contextText: HOST_CONTEXT_TEXT,
  })
  assert.deepEqual(launch.argv, [
    'claude',
    '--append-system-prompt-file',
    HOST_CONTEXT_FILE,
    '--session-id',
    'sid_ctx',
  ])
  // Being re-told on resume is the whole reason this moved off the first user
  // message: the old prompt append was skipped entirely when resuming.
  const resume = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 'sid_ctx',
    resume: true,
    contextFile: HOST_CONTEXT_FILE,
    contextText: HOST_CONTEXT_TEXT,
  })
  assert.deepEqual(resume.argv, [
    'claude',
    '--append-system-prompt-file',
    HOST_CONTEXT_FILE,
    '--resume',
    'sid_ctx',
  ])
  // The two hosted-model runtimes run the same binary and take the same flag.
  for (const cli of ['kimi-claude', 'zai'] as const) {
    const hosted = renderAgentLaunchArgv({
      cli,
      sessionId: 'sid_ctx',
      contextFile: HOST_CONTEXT_FILE,
      contextText: HOST_CONTEXT_TEXT,
    })
    assert.ok(hosted.argv.includes('--append-system-prompt-file'), cli)
  }
}

function testCodexTakesTheContextAsAnEscapedTomlOverride(): void {
  const launch = renderAgentLaunchArgv({
    cli: 'codex',
    sessionId: 'sid_ctx',
    contextFile: HOST_CONTEXT_FILE,
    contextText: HOST_CONTEXT_TEXT,
  })
  const override = launch.argv[launch.argv.indexOf('-c') + 1]
  // `-c` parses its value as TOML: a raw newline would be a parse error, and a
  // raw quote would silently truncate the document.
  assert.equal(
    override,
    'developer_instructions="Host context.\\nA design system is attached at `design-system/`."',
  )
  assert.ok(!override.includes('\n'), 'no literal newline reaches codex’s TOML parser')

  // Codex persists its own per-session config, so re-passing the override on
  // resume would clobber whatever the session already has — the same rule the
  // reasoning-effort override follows there.
  const resume = renderAgentLaunchArgv({
    cli: 'codex',
    sessionId: 'sid_ctx',
    resume: true,
    contextFile: HOST_CONTEXT_FILE,
    contextText: HOST_CONTEXT_TEXT,
  })
  assert.ok(!resume.argv.some((arg) => arg.startsWith('developer_instructions=')))
}

function testGrokTakesTheContextTextOnLaunchAndResume(): void {
  for (const resume of [false, true]) {
    const out = renderAgentLaunchArgv({
      cli: 'grok',
      sessionId: 'sid_ctx',
      resume,
      contextFile: HOST_CONTEXT_FILE,
      contextText: HOST_CONTEXT_TEXT,
    })
    const flagAt = out.argv.indexOf('--append-system-prompt')
    assert.ok(flagAt >= 0, `grok should carry the flag (resume: ${resume})`)
    // Text, not a path: grok documents no file-taking variant.
    assert.equal(out.argv[flagAt + 1], HOST_CONTEXT_TEXT)
  }
}

function testAModuleHostContextSectionRidesTheDeclaredChannel(): void {
  const text = [
    HOST_CONTEXT_TEXT,
    '',
    '## Sprint Engine',
    '',
    'Use the sprintengine CLI for run tools.',
  ].join('\n')
  const grok = renderAgentLaunchArgv({
    cli: 'grok',
    sessionId: 'sid_mod',
    contextFile: HOST_CONTEXT_FILE,
    contextText: text,
  })
  const grokFlag = grok.argv.indexOf('--append-system-prompt')
  assert.ok(grokFlag >= 0)
  assert.equal(grok.argv[grokFlag + 1], text)
  assert.ok(String(grok.argv[grokFlag + 1]).includes('## Sprint Engine'))

  const claude = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 'sid_mod',
    contextFile: HOST_CONTEXT_FILE,
    contextText: text,
  })
  assert.deepEqual(
    [claude.argv[claude.argv.indexOf('--append-system-prompt-file') + 1]],
    [HOST_CONTEXT_FILE],
    'claude still takes the file; the extra section lives in the document, not the argv'
  )
}

function testOpenCodeTakesTheContextThroughItsConfigEnv(): void {
  for (const resume of [false, true]) {
    const out = renderAgentLaunchArgv({
      cli: 'opencode',
      sessionId: 'sid_ctx',
      resume,
      contextFile: HOST_CONTEXT_FILE,
      contextText: HOST_CONTEXT_TEXT,
    })
    assert.equal(out.env.OPENCODE_CONFIG_CONTENT, `{"instructions":[${JSON.stringify(HOST_CONTEXT_FILE)}]}`)
    // The env is the channel; nothing goes on the command line.
    assert.ok(!out.argv.some((arg) => arg.includes('instructions')), 'no argv leakage')
  }
  // A Windows path has backslashes, which are escapes inside a JSON string: the
  // path is embedded as a JSON literal so the config still parses.
  const windowsFile = 'C:\\Users\\me\\AppData\\Roaming\\Studio\\host-context\\sid.md'
  const windows = renderAgentLaunchArgv({
    cli: 'opencode',
    sessionId: 'sid_ctx',
    contextFile: windowsFile,
    contextText: HOST_CONTEXT_TEXT,
  })
  const parsed = JSON.parse(windows.env.OPENCODE_CONFIG_CONTENT) as { instructions: string[] }
  assert.deepEqual(parsed.instructions, [windowsFile])
}

// A CLI with no out-of-band channel declares `prompt`: main wraps the document
// into the prompt instead, and the manifest renders no flag and no env.
function testPromptFallbackCliRendersNoContextFlag(): void {
  for (const cli of ['kimi-code', 'muse'] as const) {
    const out = renderAgentLaunchArgv({
      cli,
      sessionId: 'sid_ctx',
      contextFile: HOST_CONTEXT_FILE,
      contextText: HOST_CONTEXT_TEXT,
    })
    assert.ok(!out.argv.includes(HOST_CONTEXT_FILE), cli)
    assert.ok(!out.argv.includes(HOST_CONTEXT_TEXT), cli)
    assert.deepEqual(out.env, {}, cli)
  }
}

// Cursor has no system-prompt flag. The document is packed as a plugin
// directory and handed over --plugin-dir, on launch AND resume, so a resumed
// session is still told — the same reason Claude's file flag rides resume.
function testCursorTakesTheContextAsAPluginDirOnLaunchAndResume(): void {
  const pluginDir = '/ctx/sid-plugin'
  const launch = renderAgentLaunchArgv({
    cli: 'cursor',
    sessionId: 'sid_ctx',
    initialPrompt: 'fix the tests',
    contextFile: pluginDir,
    contextText: HOST_CONTEXT_TEXT,
  })
  assert.deepEqual(launch.argv, ['cursor-agent', '--plugin-dir', pluginDir, 'fix the tests'])
  assert.ok(!launch.argv.includes(HOST_CONTEXT_TEXT), 'the document itself does not ride argv or the prompt')
  const resume = renderAgentLaunchArgv({
    cli: 'cursor',
    sessionId: 'sid_ctx',
    resume: true,
    contextFile: pluginDir,
    contextText: HOST_CONTEXT_TEXT,
  })
  assert.deepEqual(resume.argv, [
    'cursor-agent',
    '--plugin-dir',
    pluginDir,
    '--continue',
    '--resume',
    'sid_ctx',
  ])
}

// The receipt line previews the flags a launch would carry. Host context is not
// one of them: it is not a control on the row, and a whole markdown document (or
// a userData path) rendered into a one-line receipt tells the reader nothing.
function testLaunchPreviewNeverShowsHostContext(): void {
  const preview = renderAgentLaunchPreview({ cli: 'claude-code' })
  assert.ok(!preview.args.includes('--append-system-prompt-file'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
