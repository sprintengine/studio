import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test, vi } from 'vitest'

import type { AgentCli } from '../shared/electron-api'
import { planAgentLaunch, renderAgentLaunchArgv, type AgentLaunchRenderInput } from './agent-launch-render'
import { LAUNCH_ARG_BUDGETS } from './launch-arg-budget'
import { createPluginRegistry } from './plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from './plugin-registry-instance'
import { buildNativeAgentLaunchPowerShellScript, getShellLaunchConfig } from './terminal-launch'

vi.mock('electron', () => import('../../tests/stubs/electron'))

// How each bundled CLI takes its first message, and what a launch does for the
// ones that take it only typed in (`send-after-ready`): the message is owed to
// the CLI exactly once, on a new launch only, and the launch says when its CLI
// has exited so nothing is typed into the shell after it — on every platform.

const LINUX = LAUNCH_ARG_BUDGETS.linux
const WINDOWS = LAUNCH_ARG_BUDGETS.windows
const PROMPT = 'Fix the failing test in src/app.ts: it says "expected 2".'

let temp = ''
let bundledClis: AgentCli[] = []

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'se-send-after-ready-'))
  __resetPluginRegistryForTest()
  const registry = createPluginRegistry({
    bundledRoot: join(process.cwd(), 'resources', 'plugins'),
    userRoot: join(temp, 'no-user-plugins'),
  })
  const report = registry.loadSync()
  assert.deepEqual(report.rejected, [], 'bundled manifests load clean')
  __setPluginRegistryForTest(registry, report)
  bundledClis = registry.list().map((plugin) => plugin.id as AgentCli)
})

afterAll(() => {
  __resetPluginRegistryForTest()
  rmSync(temp, { recursive: true, force: true })
})

function plan(input: AgentLaunchRenderInput, budget = LINUX) {
  return planAgentLaunch(input, { budget, log: () => {} })
}

// Where an ordinary first message goes, per bundled CLI. A CLI added to the
// bundle without a row here fails the first test: someone has to decide.
const FIRST_MESSAGE_DELIVERY: Record<string, 'argv' | 'typed' | 'none'> = {
  'claude-code': 'argv',
  'kimi-claude': 'argv',
  zai: 'argv',
  codex: 'argv',
  cursor: 'argv',
  opencode: 'argv',
  grok: 'argv',
  'kimi-code': 'typed',
  muse: 'typed',
  // A plain shell renders no prompt anywhere.
  'generic-shell': 'none',
}

test('every bundled CLI takes its first message the way its manifest says', () => {
  assert.deepEqual([...bundledClis].sort(), Object.keys(FIRST_MESSAGE_DELIVERY).sort())
  for (const cli of bundledClis) {
    const planned = plan({ cli, sessionId: 'sid', initialPrompt: PROMPT })
    const expected = FIRST_MESSAGE_DELIVERY[cli]
    if (expected === 'typed') {
      assert.deepEqual(planned.promptDelivery, { kind: 'input', text: PROMPT }, cli)
      assert.ok(!planned.argv.includes(PROMPT), `${cli} carries no prompt on its command line`)
    } else {
      assert.deepEqual(planned.promptDelivery, { kind: 'argv' }, cli)
      assert.equal(planned.argv.includes(PROMPT), expected === 'argv', `${cli}: ${planned.argv.join(' ')}`)
    }
  }
})

test('a send-after-ready launch owes nothing on resume, with nothing to say, or with only whitespace', () => {
  for (const cli of ['kimi-code', 'muse'] as AgentCli[]) {
    for (const input of [
      { cli, sessionId: 'sid', resume: true, initialPrompt: PROMPT },
      // Debug Mode would otherwise conjure a message on a resume.
      { cli, sessionId: 'sid', resume: true, debugMode: true },
      { cli, sessionId: 'sid' },
      { cli, sessionId: 'sid', initialPrompt: '  \n ' },
    ] satisfies AgentLaunchRenderInput[]) {
      let planned: ReturnType<typeof plan>
      try {
        planned = plan(input)
      } catch {
        continue // Muse declares no resume
      }
      assert.deepEqual(planned.promptDelivery, { kind: 'argv' }, JSON.stringify(input))
      assert.equal(planned.typedPromptEnv, undefined, JSON.stringify(input))
    }
  }
})

test("Debug Mode's directive is typed in with the message on a new launch", () => {
  const expected = renderAgentLaunchArgv({ cli: 'kimi-code', sessionId: 's', initialPrompt: PROMPT, debugMode: true })
  const planned = plan({ cli: 'kimi-code', sessionId: 's', initialPrompt: PROMPT, debugMode: true })
  assert.deepEqual(planned.promptDelivery, { kind: 'input', text: expected.prompt })
  assert.ok(expected.prompt && expected.prompt.length > PROMPT.length)
})

test("Kimi Code's typed launch turns its startup update prompt off, and only that launch", () => {
  assert.deepEqual(plan({ cli: 'kimi-code', sessionId: 's', initialPrompt: PROMPT }).typedPromptEnv, {
    KIMI_CODE_NO_AUTO_UPDATE: '1',
  })
  assert.equal(plan({ cli: 'kimi-code', sessionId: 's' }).typedPromptEnv, undefined)
  // Never through launch.env, which every launch carries.
  assert.deepEqual(renderAgentLaunchArgv({ cli: 'kimi-code', sessionId: 's', initialPrompt: PROMPT }).env, {})
})

function launch(cli: AgentCli, prompt: string | undefined, target?: Parameters<typeof getShellLaunchConfig>[15]) {
  const cwd = join(temp, `workspace-${cli}`)
  mkdirSync(cwd, { recursive: true })
  return getShellLaunchConfig(
    cwd,
    `sid-${cli}`,
    false,
    cli,
    prompt,
    { [cli]: { command: cli === 'kimi-code' ? 'kimi' : cli } },
    'manual',
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    target,
  )
}

const CLI_EXITED = 'sprintengine-cli-exited'

test('a POSIX Kimi Code launch hands its first message back to be typed, and says when the CLI exits', () => {
  const config = launch('kimi-code', PROMPT)
  assert.equal(config.deferredPrompt, PROMPT)
  const script = readFileSync(config.startupScriptPath ?? '', 'utf8')
  assert.ok(!script.includes('expected 2'), 'the message is not in the script')
  // Set for the CLI alone, not exported into the shell it leaves behind.
  assert.ok(script.includes("KIMI_CODE_NO_AUTO_UPDATE='1' kimi"), script.slice(-500))
  assert.ok(!script.includes('export KIMI_CODE_NO_AUTO_UPDATE'))
  const cliAt = script.indexOf("KIMI_CODE_NO_AUTO_UPDATE='1' kimi")
  const sentinelAt = script.indexOf(CLI_EXITED)
  const shellAt = script.lastIndexOf('exec ')
  assert.ok(cliAt > 0 && sentinelAt > cliAt && shellAt > sentinelAt, script.slice(-600))

  const quiet = launch('kimi-code', undefined)
  assert.equal(quiet.deferredPrompt, undefined)
  const quietScript = readFileSync(quiet.startupScriptPath ?? '', 'utf8')
  assert.ok(!quietScript.includes(CLI_EXITED), 'a launch with nothing to type is unchanged')
  assert.ok(!quietScript.includes('KIMI_CODE_NO_AUTO_UPDATE'))
})

test('a WSL Kimi Code launch does the same inside the distribution', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  let config: ReturnType<typeof getShellLaunchConfig>
  try {
    config = launch('kimi-code', PROMPT, {
      kind: 'wsl',
      distro: 'Ubuntu',
      env: {},
      sessionDir: '/home/dev/.local/share/sprintengine-studio/sessions/abc123def456',
      pidDir: '/run/user/1000/sprintengine/abc123def456/sessions',
    })
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform)
  }
  assert.equal(config.deferredPrompt, PROMPT)
  const script = config.hostFiles?.find((file) => file.path === config.startupScriptPath)?.content ?? ''
  assert.ok(!script.includes('expected 2'))
  assert.ok(script.includes("KIMI_CODE_NO_AUTO_UPDATE='1' kimi"), script.slice(-500))
  assert.ok(script.indexOf(CLI_EXITED) > script.indexOf("KIMI_CODE_NO_AUTO_UPDATE='1' kimi"))
})

test('a native Windows Kimi Code launch does the same in its PowerShell script', () => {
  let delivery: unknown
  const script = buildNativeAgentLaunchPowerShellScript(
    'kimi-code',
    'sid',
    false,
    'C:\\Users\\dev\\repo',
    PROMPT,
    { command: '' },
    'manual',
    undefined,
    false,
    undefined,
    {},
    [],
    undefined,
    { budget: WINDOWS, log: () => {} },
    (planned) => {
      delivery = planned.promptDelivery
    },
  )
  assert.deepEqual(delivery, { kind: 'input', text: PROMPT })
  assert.ok(!script.includes('expected 2'))
  const envAt = script.indexOf("$env:KIMI_CODE_NO_AUTO_UPDATE = '1'")
  const clearAt = script.indexOf('Remove-Item Env:KIMI_CODE_NO_AUTO_UPDATE')
  const sentinelAt = script.indexOf(CLI_EXITED)
  assert.ok(envAt > 0 && clearAt > envAt && sentinelAt > clearAt, script)

  const resumed = buildNativeAgentLaunchPowerShellScript('kimi-code', 'sid', true, 'C:\\Users\\dev\\repo', PROMPT, {
    command: '',
  })
  assert.ok(!resumed.includes(CLI_EXITED), 'a resume types nothing')
  assert.ok(!resumed.includes('KIMI_CODE_NO_AUTO_UPDATE'))
})
