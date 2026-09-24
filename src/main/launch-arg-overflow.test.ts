import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test, vi } from 'vitest'

import type { AgentCli } from '../shared/electron-api'
import {
  hostContextTruncationMarker,
  planAgentLaunch,
  promptFileNote,
  renderAgentLaunchArgv,
  type AgentLaunchRenderInput,
} from './agent-launch-render'
import {
  LAUNCH_ARG_BUDGETS,
  launchArgBudgetFor,
  launchArgvExceedsBudget,
  measureLaunchArg,
  measureLaunchArgv,
  type LaunchArgBudget,
} from './launch-arg-budget'
import { createPluginRegistry } from './plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from './plugin-registry-instance'
import { buildCodexLegacyNativeAgentLaunchPowerShellScript, getShellLaunchConfig } from './terminal-launch'

vi.mock('electron', () => import('../../tests/stubs/electron'))

// A first message or a host-context document too long for the platform's
// command line must never reach the exec: Linux and WSL refuse any argument
// over 128 KiB, Windows a command line over 32,767 code units. These cases pin
// what the launch does instead, and that everything it still renders fits.

const LINUX = LAUNCH_ARG_BUDGETS.linux
const WINDOWS = LAUNCH_ARG_BUDGETS.windows
const DARWIN = LAUNCH_ARG_BUDGETS.darwin

let temp = ''
let bundledClis: AgentCli[] = []

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'se-launch-overflow-'))
  __resetPluginRegistryForTest()
  const registry = createPluginRegistry({
    bundledRoot: join(process.cwd(), 'resources', 'plugins'),
    userRoot: join(temp, 'no-user-plugins'),
  })
  const report = registry.loadSync()
  assert.deepEqual(report.rejected, [], 'bundled manifests load clean')
  __setPluginRegistryForTest(registry, report)
  bundledClis = registry.list().map((plugin) => plugin.id as AgentCli)
  assert.ok(bundledClis.includes('claude-code') && bundledClis.includes('opencode'), bundledClis.join(', '))
})

afterAll(() => {
  __resetPluginRegistryForTest()
  rmSync(temp, { recursive: true, force: true })
})

/** A pasted log of about `bytes`, multi-line and with a quote in it, as a real one has. */
function pastedLog(bytes: number): string {
  const line = `2026-09-24T12:00:00Z ERROR build failed: "can't resolve module" at src/index.ts:42\n`
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes)
}

function silentPlan(
  input: AgentLaunchRenderInput,
  budget: LaunchArgBudget,
  writePromptFile?: (text: string) => string | null,
) {
  const logged: Array<{ event: string; detail: Record<string, unknown> }> = []
  const plan = planAgentLaunch(input, {
    budget,
    ...(writePromptFile ? { writePromptFile } : {}),
    log: (event, detail) => logged.push({ event, detail }),
  })
  return { plan, logged }
}

test('the budgets sit inside each platform limit', () => {
  assert.ok(LINUX.maxArg < 128 * 1024, 'under MAX_ARG_STRLEN')
  assert.ok(DARWIN.maxTotal < 1024 * 1024, 'under the macOS ARG_MAX')
  assert.ok(WINDOWS.maxTotal < 32_767, 'under the CreateProcess command line')
  assert.equal(launchArgBudgetFor('wsl', 'win32'), LINUX, 'WSL execs inside Linux')
  assert.equal(launchArgBudgetFor('windows', 'win32'), WINDOWS)
  assert.equal(launchArgBudgetFor('posix', 'darwin'), DARWIN)
  assert.equal(launchArgBudgetFor('posix', 'linux'), LINUX)
  // Bytes on POSIX (a non-ASCII character costs more than one), quoted code
  // units on Windows (a quote costs its escape).
  assert.equal(measureLaunchArg('é', LINUX), 3)
  assert.equal(measureLaunchArg('a "b"', WINDOWS), '"a \\"b\\""'.length + 1)
})

test('a 200 KB first message on a Linux budget is typed in, and argv carries none of it', () => {
  const prompt = pastedLog(200 * 1024)
  const input: AgentLaunchRenderInput = { cli: 'claude-code', sessionId: 'sid-linux', initialPrompt: prompt }
  const { plan, logged } = silentPlan(input, LINUX)
  assert.deepEqual(plan.promptDelivery, { kind: 'input', text: prompt })
  assert.equal(launchArgvExceedsBudget(plan.argv, LINUX), false)
  assert.ok(
    measureLaunchArgv(plan.argv, LINUX).largest < 1024,
    `no large element: ${plan.argv.join(' ').slice(0, 300)}`,
  )
  assert.ok(!plan.argv.some((arg) => arg.includes('ERROR build failed')), 'the prompt is not on the command line')
  // Everything else is the launch it would have been with nothing typed.
  assert.deepEqual(plan.argv, renderAgentLaunchArgv({ ...input, initialPrompt: undefined }).argv)
  assert.deepEqual(
    logged.map((entry) => entry.event),
    ['prompt-moved-off-command-line'],
  )
})

test('a 40K-character first message on a Windows budget is typed in', () => {
  const prompt = pastedLog(40_000)
  for (const cli of ['claude-code', 'cursor', 'codex'] as AgentCli[]) {
    const { plan } = silentPlan({ cli, sessionId: 'sid-win', initialPrompt: prompt }, WINDOWS)
    assert.deepEqual(plan.promptDelivery, { kind: 'input', text: prompt }, cli)
    assert.equal(launchArgvExceedsBudget(plan.argv, WINDOWS), false, cli)
    assert.ok(!plan.argv.some((arg) => arg.includes('ERROR build failed')), cli)
  }
})

test('Codex gets its update check turned off only on a launch whose prompt is typed in', () => {
  const small = renderAgentLaunchArgv({ cli: 'codex', sessionId: 's', initialPrompt: 'hi' }).argv
  assert.ok(!small.includes('check_for_update_on_startup=false'), 'an ordinary launch is untouched')
  const { plan } = silentPlan({ cli: 'codex', sessionId: 's', initialPrompt: pastedLog(150 * 1024) }, LINUX)
  const at = plan.argv.indexOf('check_for_update_on_startup=false')
  assert.ok(at > 0 && plan.argv[at - 1] === '-c', plan.argv.join(' '))
})

test('a Windows Codex launch script built on a plan carries no oversized argument', () => {
  const prompt = pastedLog(40_000)
  let delivery: unknown
  const script = buildCodexLegacyNativeAgentLaunchPowerShellScript(
    'sid',
    false,
    'C:\\Users\\dev\\repo',
    prompt,
    { command: '' },
    'manual',
    undefined,
    false,
    undefined,
    {},
    undefined,
    { budget: WINDOWS, log: () => {} },
    (plan) => {
      delivery = plan.promptDelivery
    },
  )
  assert.deepEqual(delivery, { kind: 'input', text: prompt })
  // The arguments ride the script base64-encoded; a 40K prompt would be 53K+ of it.
  assert.ok(script.length < 8_000, `script is ${script.length} characters`)
})

test('an ordinary prompt stays on the command line, byte for byte, for every bundled CLI on every platform', () => {
  const prompt = 'Fix the failing test in src/app.ts — it says "expected 2".'
  for (const cli of bundledClis) {
    for (const budget of [LINUX, DARWIN, WINDOWS]) {
      for (const resume of [false, true]) {
        const input: AgentLaunchRenderInput = { cli, sessionId: 'sid', initialPrompt: prompt, resume }
        let expected: string[]
        try {
          expected = renderAgentLaunchArgv(input).argv
        } catch {
          continue // no resume declared
        }
        const { plan, logged } = silentPlan(input, budget)
        assert.deepEqual(plan.argv, expected, `${cli} ${budget.platform} resume=${resume}`)
        // A CLI that takes its first message no way but typed in gets it typed
        // in on a new launch, and a resume never sends it again.
        const typed =
          !resume && renderAgentLaunchArgv(input).plugin.manifest.promptInjection.mode === 'send-after-ready'
        assert.deepEqual(plan.promptDelivery, typed ? { kind: 'input', text: prompt } : { kind: 'argv' }, cli)
        assert.deepEqual(logged, [])
      }
    }
  }
})

test('no bundled CLI renders an argument over the platform budget, whatever it is handed', () => {
  // The guard this whole change exists for: a huge first message AND a huge
  // host-context document, on every platform, launch and resume alike.
  const prompt = pastedLog(1024 * 1024)
  const contextText = `# Host context\n\n${pastedLog(1024 * 1024)}`
  for (const cli of bundledClis) {
    for (const budget of [LINUX, DARWIN, WINDOWS]) {
      for (const resume of [false, true]) {
        const input: AgentLaunchRenderInput = {
          cli,
          sessionId: 'sid',
          resume,
          initialPrompt: prompt,
          debugMode: true,
          contextFile: '/Users/dev/.config/sprintengine/host-context/sid.md',
          contextText,
        }
        try {
          renderAgentLaunchArgv(input)
        } catch {
          continue // no resume declared
        }
        const { plan } = silentPlan(input, budget, () => '/Users/dev/.config/sprintengine/launch-prompts/sid.md')
        const measured = measureLaunchArgv(plan.argv, budget)
        assert.ok(
          measured.largest <= budget.maxArg && measured.total <= budget.maxTotal,
          `${cli} on ${budget.platform} (resume=${resume}) renders ${JSON.stringify(measured)} against ${budget.maxArg}/${budget.maxTotal}`,
        )
        assert.equal(plan.overBudget, undefined, `${cli} ${budget.platform}`)
      }
    }
  }
})

test("Codex's host-context document is cut to fit, with a marker naming the file that holds all of it", () => {
  const contextFile = '/home/dev/.local/share/sprintengine-studio/host-context/sid.md'
  const contextText = `# Design system\n\n${pastedLog(300 * 1024)}`
  const { plan, logged } = silentPlan(
    { cli: 'codex', sessionId: 'sid', initialPrompt: 'hi', contextFile, contextText },
    LINUX,
  )
  const override = plan.argv.find((arg) => arg.startsWith('developer_instructions='))
  assert.ok(override, plan.argv.join(' ').slice(0, 300))
  assert.ok(measureLaunchArg(override, LINUX) <= LINUX.maxArg)
  assert.ok(override.includes('Host context truncated'), 'the cut is marked')
  assert.ok(override.includes(contextFile), 'and names where the rest is')
  assert.ok(override.endsWith('"'), 'still one TOML basic string')
  assert.ok(plan.contextTruncated && plan.contextTruncated.shown < plan.contextTruncated.total)
  assert.deepEqual(plan.promptDelivery, { kind: 'argv' }, 'a small prompt stays where it was')
  assert.ok(logged.some((entry) => entry.event === 'host-context-truncated'))
})

test("Grok's host-context text is cut to fit on Windows, and an ordinary one is untouched", () => {
  const contextFile = 'C:\\Users\\dev\\AppData\\Roaming\\SprintEngine Studio\\host-context\\sid.md'
  const { plan } = silentPlan(
    { cli: 'grok', sessionId: 'sid', contextFile, contextText: `# Rules\n\n${pastedLog(60_000)}` },
    WINDOWS,
  )
  const at = plan.argv.indexOf('--append-system-prompt')
  const text = plan.argv[at + 1] ?? ''
  assert.ok(at > 0)
  assert.ok(
    text.endsWith(hostContextTruncationMarker(plan.contextTruncated?.shown ?? -1, 60_009, contextFile)),
    text.slice(-300),
  )
  assert.equal(launchArgvExceedsBudget(plan.argv, WINDOWS), false)

  const small = silentPlan({ cli: 'grok', sessionId: 'sid', contextFile, contextText: '# Rules\n\nBe brief.' }, WINDOWS)
  assert.equal(small.plan.argv[small.plan.argv.indexOf('--append-system-prompt') + 1], '# Rules\n\nBe brief.')
  assert.equal(small.plan.contextTruncated, undefined)
})

test('OpenCode takes an overflowed message as a documented file attachment, with a note first', () => {
  const prompt = pastedLog(200 * 1024)
  const written: string[] = []
  const path = '/Users/dev/.config/sprintengine/launch-prompts/sid.md'
  const { plan } = silentPlan({ cli: 'opencode', sessionId: 'sid', initialPrompt: prompt }, LINUX, (text) => {
    written.push(text)
    return path
  })
  assert.deepEqual(written, [prompt])
  assert.deepEqual(plan.promptDelivery, { kind: 'file', text: prompt, path })
  assert.deepEqual(plan.argv.slice(-3), [promptFileNote(path), '--file', path])

  // A file that could not be written leaves it on the command line: `run` has
  // no line editor to type it into, and a refused launch at least says so.
  const unwritable = silentPlan({ cli: 'opencode', sessionId: 'sid', initialPrompt: prompt }, LINUX, () => null)
  assert.deepEqual(unwritable.plan.promptDelivery, { kind: 'argv' })
  assert.equal(unwritable.plan.argv.at(-1), prompt)
  assert.equal(unwritable.plan.overBudget, true)
})

test("Debug Mode's directive travels with the typed-in message", () => {
  const prompt = pastedLog(200 * 1024)
  const expected = renderAgentLaunchArgv({
    cli: 'claude-code',
    sessionId: 's',
    initialPrompt: prompt,
    debugMode: true,
  }).prompt
  const { plan } = silentPlan({ cli: 'claude-code', sessionId: 's', initialPrompt: prompt, debugMode: true }, LINUX)
  assert.equal(plan.promptDelivery.kind, 'input')
  assert.equal(plan.promptDelivery.kind === 'input' && plan.promptDelivery.text, expected)
  assert.ok(expected && expected.length > prompt.length)
})

test("Grok's first message rides the command line after `--`, and an oversized one is typed in with updates off", () => {
  // A bare `grok version` runs the subcommand; with `--` in front the TUI opens
  // with it as the prompt (verified against 1.0.41), so a one-word message never
  // runs a subcommand.
  const small = silentPlan({ cli: 'grok', sessionId: 's', initialPrompt: 'update' }, LINUX).plan
  assert.deepEqual(small.promptDelivery, { kind: 'argv' })
  assert.deepEqual(small.argv.slice(-2), ['--', 'update'])
  assert.ok(!small.argv.includes('--no-auto-update'), 'an ordinary launch is untouched')
  const dashed = silentPlan({ cli: 'grok', sessionId: 's', initialPrompt: '--help me' }, LINUX).plan
  assert.deepEqual(dashed.argv.slice(-2), ['--', '--help me'])
  const none = renderAgentLaunchArgv({ cli: 'grok', sessionId: 's' }).argv
  assert.ok(!none.includes('--'), 'no separator without a prompt')

  const prompt = pastedLog(300 * 1024)
  const { plan } = silentPlan({ cli: 'grok', sessionId: 's', initialPrompt: prompt }, LINUX)
  assert.deepEqual(plan.promptDelivery, { kind: 'input', text: prompt })
  assert.ok(plan.argv.includes('--no-auto-update'), plan.argv.join(' '))
  assert.ok(!plan.argv.includes('--'), 'the typed launch carries no prompt and so no separator')
  assert.equal(launchArgvExceedsBudget(plan.argv, LINUX), false)
})

test('a resumed Claude Code session with a long message types it in too', () => {
  const prompt = pastedLog(200 * 1024)
  const { plan } = silentPlan({ cli: 'claude-code', sessionId: 'sid', resume: true, initialPrompt: prompt }, LINUX)
  assert.deepEqual(plan.promptDelivery, { kind: 'input', text: prompt })
  assert.ok(plan.argv.includes('--resume'))
  assert.equal(launchArgvExceedsBudget(plan.argv, LINUX), false)
})

// ── Through the real launch builder ─────────────────────────────────────────

const SESSION_DIR = '/home/dev/.local/share/sprintengine-studio/sessions/abc123def456'
const PID_DIR = '/run/user/1000/sprintengine/abc123def456/sessions'

function launch(cwd: string, prompt: string, target?: Parameters<typeof getShellLaunchConfig>[15]) {
  return getShellLaunchConfig(
    cwd,
    'sid-overflow',
    false,
    'claude-code',
    prompt,
    { 'claude-code': { command: 'claude' } },
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

test('a WSL launch with a 200 KB first message leaves it out of the startup script and hands it back', () => {
  const cwd = join(temp, 'wsl-workspace')
  mkdirSync(cwd, { recursive: true })
  const prompt = pastedLog(200 * 1024)
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  let config: ReturnType<typeof getShellLaunchConfig>
  try {
    config = launch(cwd, prompt, { kind: 'wsl', distro: 'Ubuntu', env: {}, sessionDir: SESSION_DIR, pidDir: PID_DIR })
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform)
  }
  assert.equal(config.deferredPrompt, prompt)
  const script = config.hostFiles?.find((file) => file.path === config.startupScriptPath)?.content ?? ''
  assert.ok(script.includes('--session-id'), script.slice(0, 500))
  assert.ok(!script.includes('ERROR build failed'), 'the exec inside the distribution carries none of it')
  assert.ok(script.length < 16 * 1024, `startup script is ${script.length} bytes`)
})

test('a POSIX launch with a small first message is unchanged; a 300 KB one on macOS is typed in', () => {
  const cwd = join(temp, 'posix-workspace')
  mkdirSync(cwd, { recursive: true })
  const small = launch(cwd, 'hello there')
  assert.equal(small.deferredPrompt, undefined)
  assert.ok(readFileSync(small.startupScriptPath ?? '', 'utf8').includes("'hello there'"))

  const prompt = pastedLog(300 * 1024)
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  let config: ReturnType<typeof getShellLaunchConfig>
  try {
    config = launch(cwd, prompt)
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform)
  }
  assert.equal(config.deferredPrompt, prompt)
  const script = readFileSync(config.startupScriptPath ?? '', 'utf8')
  assert.ok(!script.includes('ERROR build failed'))
})

test('a host-context document that fits is never cut, even when it is most of the budget', () => {
  const contextFile = 'C:\\Users\\dev\\AppData\\Roaming\\SprintEngine Studio\\host-context\\sid.md'
  const contextText = `# Design system\n\n${'Use the tokens. '.repeat(1_250)}`
  assert.ok(contextText.length > 20_000)
  for (const cli of ['codex', 'grok'] as AgentCli[]) {
    const input: AgentLaunchRenderInput = { cli, sessionId: 'sid', contextFile, contextText }
    const { plan, logged } = silentPlan(input, WINDOWS)
    assert.deepEqual(plan.argv, renderAgentLaunchArgv(input).argv, cli)
    assert.equal(plan.contextTruncated, undefined, cli)
    assert.deepEqual(logged, [], cli)
  }
})

test('only a launch whose prompt is typed in announces its CLI exiting, before the shell starts', () => {
  const cwd = join(temp, 'sentinel-workspace')
  mkdirSync(cwd, { recursive: true })
  const small = readFileSync(launch(cwd, 'hello there').startupScriptPath ?? '', 'utf8')
  assert.ok(!small.includes('sprintengine-cli-exited'), 'an ordinary launch is unchanged')
  const typed = launch(cwd, pastedLog(600 * 1024))
  const script = readFileSync(typed.startupScriptPath ?? '', 'utf8')
  const cliAt = script.indexOf('--session-id')
  const sentinelAt = script.indexOf("printf '\\033]6973;sprintengine-cli-exited\\007'")
  const shellAt = script.lastIndexOf('exec ')
  assert.ok(cliAt > 0 && sentinelAt > cliAt && shellAt > sentinelAt, script.slice(-600))
})
