import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  argvToPosixShellCommand,
  buildAgentShellCommand,
  pluginIdForCli,
  quotePosixToken,
  renderAgentLaunchArgv,
  resolveCliRuntimeSettings,
} from './agent-launch-render'
import { createPluginRegistry } from './plugin-registry'
import {
  __resetPluginRegistryForTest,
  __setPluginRegistryForTest,
} from './plugin-registry-instance'

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
    testQuoteTokenLeavesSafeStringsBare()
    testQuoteTokenWrapsSpecialChars()
    testArgvToPosixShellCommand()
    testBuildAgentShellCommandClaudeCode()
    testBuildAgentShellCommandCodex()
    testRenderArgvIncludesBinaryAsFirstElement()
    testResolveCliRuntimeSettings()
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
  const out = renderAgentLaunchArgv({
    cli: 'codex',
    sessionId: 'sid_z',
    resume: true,
  })
  assert.deepEqual(out.argv, ['codex', 'resume'])
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
    `if ! command -v codex >/dev/null 2>&1; then echo 'Codex CLI was not found. Check the codex command in Multicode Settings.'; else codex resume; fi`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
