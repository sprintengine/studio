import assert from 'node:assert/strict'
import { join } from 'node:path'

import { DEBUG_DIRECTIVE, applyDebugDirective } from '../shared/debug-directive'
import type { SprintEngineCliPermissionPreset } from '../shared/electron-api'
import {
  argvToPosixShellCommand,
  buildAgentShellCommand,
  pluginIdForCli,
  quotePosixToken,
  renderAgentLaunchArgv,
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
    testCodexRenderDefault()
    testCodexRenderWithAutoWorkspace()
    testCodexRenderResume()
    testOpenCodeRenderDefault()
    testOpenCodeRenderWithBypassAndModel()
    testOpenCodeRenderResume()
    testClaudeCodeRenderWithModel()
    testCodexRenderWithModel()
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

function testClaudeCodeRenderWithBypass(): void {
  const out = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 'sid_42',
    initialPrompt: 'build the auth flow',
    cliPermissionPreset: 'bypass_all',
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
    cliPermissionPreset: 'bypass_all',
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
    cliPermissionPreset: 'auto_workspace',
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

// OpenCode bypass + model: the bypass_all preset adds
// --dangerously-skip-permissions and modelSelection adds --model <id>, both
// ahead of the positional prompt (launch.argv order: binary, run,
// permissionArgs, modelArgs, prompt).
function testOpenCodeRenderWithBypassAndModel(): void {
  const out = renderAgentLaunchArgv({
    cli: 'opencode',
    sessionId: 'sid_oc2',
    initialPrompt: 'build the auth flow',
    cliPermissionPreset: 'bypass_all',
    cliModel: 'anthropic/claude-opus-4',
  })
  assert.deepEqual(out.argv, [
    'opencode',
    'run',
    '--dangerously-skip-permissions',
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
    cliPermissionPreset: 'bypass_all',
  })
  assert.equal(
    out,
    `if ! command -v claude >/dev/null 2>&1; then echo 'Claude CLI was not found. Check the claude-code command in Multicode Settings.'; else claude --permission-mode bypassPermissions --session-id sid_42 'hello there'; fi`
  )

  const resumeOut = buildAgentShellCommand({
    cli: 'claude-code',
    sessionId: 'sid_42',
    resume: true,
  })
  assert.equal(
    resumeOut,
    `if ! command -v claude >/dev/null 2>&1; then echo 'Claude CLI was not found. Check the claude-code command in Multicode Settings.'; else claude --resume sid_42; fi`
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
    cliPermissionPreset: 'auto_workspace',
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
    cliPermissionPreset: 'auto_workspace',
  })
  assert.equal(
    out,
    `if ! command -v codex >/dev/null 2>&1; then echo 'Codex CLI was not found. Check the codex command in Multicode Settings.'; else codex --ask-for-approval never --sandbox workspace-write 'fix it'; fi`
  )

  const resumeOut = buildAgentShellCommand({
    cli: 'codex',
    sessionId: 'sid_y',
    resume: true,
  })
  assert.equal(
    resumeOut,
    `if ! command -v codex >/dev/null 2>&1; then echo 'Codex CLI was not found. Check the codex command in Multicode Settings.'; else codex resume sid_y; fi`
  )
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
  const presets: SprintEngineCliPermissionPreset[] = ['default', 'auto_workspace', 'bypass_all']
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
    autonomy: 'allow_changes',
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
    cliPermissionPreset: 'bypass_all',
    debugMode: true,
  })
  // Posix quoting single-quotes the whole prompt token and escapes the
  // apostrophe in the directive, so assert on a quote-free fragment + the state
  // file path rather than the raw directive string.
  assert.ok(shell.includes('You are in DEBUG MODE.'), 'posix/wsl shell command embeds the directive')
  assert.ok(shell.includes('.multi-code/debug/'), 'directive state-file path reaches the shell command')
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

// Criterion R1: the codex Windows-native LEGACY path (codex builds its argv by
// hand outside renderAgentLaunchArgv, so the shared debug boundary does not
// cover it) must (a) carry the verbatim DEBUG_DIRECTIVE into the rendered script
// when debugMode is on, and (b) keep launch/permission args byte-identical with
// debug on vs off — the same orthogonality invariant the shared paths hold.
function testCodexLegacyWindowsDebugInjection(): void {
  const presets: SprintEngineCliPermissionPreset[] = ['default', 'auto_workspace', 'bypass_all']
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
    'sid_legacy', true, cwd, undefined, runtime, 'default', undefined, false,
  )
  const resumeOn = buildCodexLegacyNativeAgentLaunchPowerShellScript(
    'sid_legacy', true, cwd, undefined, runtime, 'default', undefined, true,
  )
  assert.equal(resumeOn, resumeOff, 'codex-legacy resume: debug toggle is a no-op without an initial prompt')

  // Debug on with no initial prompt still injects the codex invocation +
  // directive as the sole prompt arg, matching
  // applyDebugDirective('', true, 'Use $debug.').
  const noPromptOn = buildCodexLegacyNativeAgentLaunchPowerShellScript(
    'sid_legacy', false, cwd, '', runtime, 'default', undefined, true,
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

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
