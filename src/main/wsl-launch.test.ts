import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test, vi } from 'vitest'

import type { McpServerConfig } from '../shared/agent-state'
import type { PluginAgentStateSpec } from '../shared/plugin-manifest'
import { buildAgentStateReporterCommand, installAgentStateReporter } from './agent-state'
import { createAgentStateService } from './agent-state-service'
import { createMcpConfigService } from './mcp-config-service'
import { createPluginRegistry } from './plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from './plugin-registry-instance'
import { mcpServersForWsl, syncStudioMcpConfig } from './studio-mcp-sync'
import { getPlainShellLaunchConfig, getShellLaunchConfig, wslStartupArgs } from './terminal-launch'
import { toWslPath } from '../shared/host-paths'
import {
  __resetWslHostForTest,
  __setDefaultWslDistroForTest,
  wslSessionPidFileCommand,
  wslSessionPidKey,
} from './hosts/wsl-distro'
import type { HostAgentIntegration } from './hosts/execution-host'

vi.mock('electron', () => import('../../tests/stubs/electron'))

// Everything an agent in WSL is handed has to make sense to a Linux process:
// its hooks run the helper's pinned Node on Linux paths and report to the
// helper's Unix socket, and nothing it starts is a Windows program. None of it
// can run here, so these cases pin the strings the launch writes and, where a
// POSIX shell is the reader, run them through one.

const PIPE = '\\\\.\\pipe\\sprintengine-agent-state-abc'
const NODE = '/home/dev/.local/share/sprintengine-studio/runtime/node-v24.21.0/bin/node'
const SOCK = '/run/user/1000/sprintengine/abc123def456/agent.sock'
// What the WSL host hands the installer: its Node, and how a native path reads there.
const WSL_RUNTIME = { executable: NODE, toCommandPath: (nativePath: string) => toWslPath(nativePath) }
const INTEGRATION: HostAgentIntegration = {
  agentStateSocketPath: SOCK,
  commandRuntime: WSL_RUNTIME,
  pluginDirs: [
    '/home/dev/.local/share/sprintengine-studio/0.4.0/plugin/sprintengine-studio',
    '/home/dev/.local/share/sprintengine-studio/0.4.0/plugin/studio-skills',
  ],
  statusLineScriptPath:
    '/home/dev/.local/share/sprintengine-studio/0.4.0/plugin/sprintengine-studio/hooks/status-line.mjs',
  studioMcpEntry: { command: NODE, args: [], env: {} },
  home: { host: '/home/dev', native: '\\\\wsl.localhost\\Ubuntu\\home\\dev' },
}

let temp = ''

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'se-wsl-launch-'))
  __resetPluginRegistryForTest()
  const registry = createPluginRegistry({
    bundledRoot: join(process.cwd(), 'resources', 'plugins'),
    userRoot: join(temp, 'no-user-plugins'),
  })
  __setPluginRegistryForTest(registry, registry.loadSync())
})

afterAll(() => {
  __resetPluginRegistryForTest()
  rmSync(temp, { recursive: true, force: true })
})

test('a drive path crosses into WSL through /mnt', () => {
  assert.equal(toWslPath('C:\\Users\\dev\\repo'), '/mnt/c/Users/dev/repo')
  assert.equal(toWslPath('D:/work/app'), '/mnt/d/work/app')
  assert.equal(toWslPath('C:\\'), '/mnt/c/')
  assert.equal(toWslPath('C:'), '/mnt/c/')
  assert.equal(
    toWslPath('C:\\Users\\dev\\AppData\\Roaming\\SprintEngine Studio\\terminal-startup\\s1.sh'),
    '/mnt/c/Users/dev/AppData/Roaming/SprintEngine Studio/terminal-startup/s1.sh',
  )
})

test('a path on the WSL share is the Linux path inside the distribution', () => {
  assert.equal(toWslPath('\\\\wsl$\\Ubuntu\\home\\dev\\repo'), '/home/dev/repo')
  assert.equal(toWslPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\repo'), '/home/dev/repo')
  assert.equal(toWslPath('\\\\WSL.LOCALHOST\\Ubuntu\\home\\dev'), '/home/dev')
  assert.equal(toWslPath('//wsl.localhost/Ubuntu/home/dev/repo'), '/home/dev/repo')
  assert.equal(toWslPath('\\\\wsl$\\Ubuntu'), '/')
})

test('a path already in Linux form is left alone', () => {
  assert.equal(toWslPath('/mnt/c/Users/dev/repo'), '/mnt/c/Users/dev/repo')
  assert.equal(toWslPath('/home/dev/repo'), '/home/dev/repo')
  assert.equal(toWslPath(toWslPath('C:\\Users\\dev')), '/mnt/c/Users/dev')
})

test('a WSL hook command runs the pinned Linux Node on the Linux path and reports to the helper', () => {
  const command = buildAgentStateReporterCommand(
    'C:\\Users\\dev\\repo\\.sprintengine\\hooks\\agent-state.mjs',
    SOCK,
    WSL_RUNTIME,
  )
  assert.equal(command, `env '${NODE}' '/mnt/c/Users/dev/repo/.sprintengine/hooks/agent-state.mjs' --socket '${SOCK}'`)
  // Native launches are unchanged.
  assert.equal(
    buildAgentStateReporterCommand('C:/Users/dev/repo/.sprintengine/hooks/agent-state.mjs', PIPE),
    `node "C:/Users/dev/repo/.sprintengine/hooks/agent-state.mjs" --socket "${PIPE}"`,
  )
})

test('a POSIX shell running the WSL hook command hands Node the paths intact, a `$` in a folder name included', () => {
  // Stand in for Node with a script that reports what it was given, and let
  // the shell a Linux CLI uses for its hooks run the command.
  const recorder = join(temp, 'Linux Node.sh')
  writeFileSync(recorder, '#!/bin/sh\nprintf "%s\\n" "$@"\n', 'utf8')
  chmodSync(recorder, 0o755)
  const hostile = '/home/dev/$(touch pwned)/`id`/.sprintengine/hooks/agent-state.mjs'
  const command = buildAgentStateReporterCommand(hostile, SOCK, { executable: recorder })
  const [script, flag, socket] = execFileSync('/bin/sh', ['-c', command], {
    cwd: temp,
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  })
    .trimEnd()
    .split('\n')
  assert.equal(script, hostile, 'nothing in the path is expanded by the shell')
  assert.equal(flag, '--socket')
  assert.equal(socket, SOCK)
})

const CURSOR_LIKE_SPEC: PluginAgentStateSpec = {
  registration: { kind: 'flat-hooks-json', path: '.cursor/hooks.json' },
  events: [{ event: 'sessionStart', phase: 'starting' }],
}

test('reinstalling a WSL hook into a flat hooks file replaces it rather than adding another', async () => {
  const root = join(temp, 'flat-hooks')
  mkdirSync(root, { recursive: true })
  const reporter = join(temp, 'reporter.mjs')
  writeFileSync(reporter, '// reporter\n', 'utf8')
  const options = { sourceScriptPath: reporter, socketPath: SOCK, homeDir: temp, commandRuntime: WSL_RUNTIME }
  assert.equal((await installAgentStateReporter(root, CURSOR_LIKE_SPEC, options)).ok, true)
  assert.equal((await installAgentStateReporter(root, CURSOR_LIKE_SPEC, options)).ok, true)
  const hooks = JSON.parse(readFileSync(join(root, '.cursor', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ command: string }>>
  }
  assert.equal(hooks.hooks.sessionStart.length, 1, JSON.stringify(hooks))
  assert.ok(hooks.hooks.sessionStart[0].command.startsWith(`env '${NODE}' `), hooks.hooks.sessionStart[0].command)
})

const CLAUDE_LIKE_SPEC: PluginAgentStateSpec = {
  registration: { kind: 'settings-json', path: '.claude/settings.local.json' },
  statusLine: true,
  events: [{ event: 'SessionStart', phase: 'starting' }],
}

test("in WSL a person's own status line is wrapped again, run by the Linux Node", async () => {
  const root = join(temp, 'status-line')
  mkdirSync(join(root, '.claude'), { recursive: true })
  const theirs = { type: 'command', command: '~/.claude/statusline.sh' }
  writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: theirs }), 'utf8')
  const reporter = join(temp, 'reporter.mjs')
  const forwarder = join(temp, 'status-line.mjs')
  writeFileSync(reporter, '// reporter\n', 'utf8')
  writeFileSync(forwarder, '// forwarder\n', 'utf8')
  const result = await installAgentStateReporter(root, CLAUDE_LIKE_SPEC, {
    sourceScriptPath: reporter,
    statusLineScriptPath: forwarder,
    socketPath: SOCK,
    homeDir: join(temp, 'home'),
    env: { CLAUDE_CONFIG_DIR: join(temp, 'claude-config') },
    commandRuntime: WSL_RUNTIME,
  })
  assert.equal(result.ok, true)
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8')) as {
    statusLine: { command: string; _sprintengineWrapped?: unknown }
    hooks: Record<string, unknown>
  }
  assert.ok(settings.statusLine.command.startsWith(`env '${NODE}' `), settings.statusLine.command)
  assert.ok(settings.statusLine.command.includes(' --wrap '), 'theirs rides along to be run')
  assert.deepEqual(settings.statusLine._sprintengineWrapped, theirs, 'and is put back on uninstall')
  assert.ok(settings.hooks.SessionStart, 'the hooks are still installed')
})

test('the MCP gateway written for a WSL launch is the helper bridge, with no WSLENV', async () => {
  const root = join(temp, 'mcp-wsl')
  mkdirSync(root, { recursive: true })
  const service = createMcpConfigService({ homeDir: () => join(temp, 'home'), userDataDir: () => join(temp, 'ud') })
  const bridge = '/home/dev/.local/share/sprintengine-studio/0.4.0/automation/mcp-stdio-bridge.mjs'
  const result = await syncStudioMcpConfig(
    {
      workspaceRoot: root,
      settings: { syncEnabled: false, servers: {} },
      clients: ['claude-code'],
      executionPathStyle: 'wsl',
    },
    {
      mcpConfigService: service,
      studioGateway: () => ({
        command: NODE,
        args: [bridge],
        env: { SPRINTENGINE_USER_DATA_DIR: '/run/user/1000/sprintengine/abc123def456' },
      }),
    },
  )
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  const config = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
  }
  const gateway = Object.values(config.mcpServers).find((server) => server.command === NODE)
  assert.ok(gateway, JSON.stringify(config))
  assert.deepEqual(gateway.args, [bridge])
  assert.equal(gateway.env.SPRINTENGINE_USER_DATA_DIR, '/run/user/1000/sprintengine/abc123def456')
  assert.equal(gateway.env.SPRINTENGINE_AGENT_CLI, 'claude-code')
  assert.equal(gateway.env.WSLENV, undefined)
})

test("Codex in WSL is told to pass the launch's MCP channel token on to the gateway, by name only", async () => {
  const root = join(temp, 'mcp-wsl-codex')
  mkdirSync(root, { recursive: true })
  const service = createMcpConfigService({ homeDir: () => join(temp, 'home'), userDataDir: () => join(temp, 'ud') })
  const result = await syncStudioMcpConfig(
    {
      workspaceRoot: root,
      settings: { syncEnabled: false, servers: {} },
      clients: ['codex'],
      executionPathStyle: 'wsl',
    },
    {
      mcpConfigService: service,
      studioGateway: () => ({
        command: NODE,
        args: ['/home/dev/.local/share/sprintengine-studio/0.4.0/automation/mcp-stdio-bridge.mjs'],
        env: { SPRINTENGINE_USER_DATA_DIR: '/run/user/1000/sprintengine/abc123def456' },
        envVarNames: ['SPRINTENGINE_MCP_CHANNEL_TOKEN'],
      }),
    },
  )
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  const config = readFileSync(join(root, '.codex', 'config.toml'), 'utf8')
  // Codex hands a stdio server only the variables its entry names.
  assert.match(config, /env_vars = \["SPRINTENGINE_MCP_CHANNEL_TOKEN"\]/u)
})

// The helper's private directories inside the distribution, as its hello
// names them.
const SESSION_DIR = '/home/dev/.local/share/sprintengine-studio/sessions/abc123def456'
const PID_DIR = '/run/user/1000/sprintengine/abc123def456/sessions'

type WslTarget = {
  kind: 'wsl'
  distro: string | null
  env: Record<string, string>
  shell?: string
  integration?: HostAgentIntegration | null
  identity?: Record<string, string>
  sessionDir?: string
  pidDir?: string
  channelToken?: string
}

// The startup script a WSL launch hands its host to write: it is never a
// file on this machine.
function scriptOf(config: { startupScriptPath?: string; hostFiles?: Array<{ path: string; content: string }> }) {
  const file = config.hostFiles?.find((entry) => entry.path === config.startupScriptPath)
  assert.ok(file, `the startup script is one of the launch's host files: ${JSON.stringify(config.hostFiles)}`)
  return file.content
}

// An agent launch on a WSL machine, the way the terminal runtime makes one:
// the host's launch target rides as the last argument, carrying the helper's
// directories unless a case says otherwise.
function launchInWsl(cwd: string, sessionId: string, target: WslTarget): ReturnType<typeof getShellLaunchConfig> {
  return getShellLaunchConfig(
    cwd,
    sessionId,
    false,
    'claude-code',
    'hello',
    { 'claude-code': { command: 'claude', hostId: target.distro ? `wsl:${target.distro}` : undefined } },
    'manual',
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    { sessionDir: SESSION_DIR, pidDir: PID_DIR, ...target },
  )
}

test('an agent in WSL gets its identity and the helper socket as exports, not through WSLENV', () => {
  const cwd = join(temp, 'workspace')
  mkdirSync(cwd, { recursive: true })
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  let config: ReturnType<typeof getShellLaunchConfig>
  try {
    config = launchInWsl(cwd, 'sid-wsl', {
      kind: 'wsl',
      distro: 'Ubuntu',
      env: {},
      integration: INTEGRATION,
      identity: {
        SPRINTENGINE_WORKSPACE_ID: 'ws-1',
        SPRINTENGINE_AGENT_ID: 'agent-1',
        SPRINTENGINE_AGENT_CLI: 'claude-code',
        // This machine's own pipe, which Linux cannot open: replaced.
        SPRINTENGINE_AGENT_STATE_SOCKET: PIPE,
      },
    })
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform)
  }
  assert.equal(config.command, 'wsl.exe')
  assert.equal(config.pathStyle, 'wsl')
  assert.equal(config.args.at(-1), config.startupScriptPath)
  assert.equal(config.env?.WSLENV, process.env.WSLENV, 'the launch leaves WSLENV as the person has it')
  const script = scriptOf(config)
  assert.ok(script.includes("export SPRINTENGINE_AGENT_ID='agent-1'"), script)
  assert.ok(script.includes("export SPRINTENGINE_WORKSPACE_ID='ws-1'"), script)
  assert.ok(script.includes(`export SPRINTENGINE_AGENT_STATE_SOCKET='${SOCK}'`), script)
  assert.ok(!script.includes('pipe'), 'the Windows pipe never reaches Linux')
  for (const dir of INTEGRATION.pluginDirs) {
    assert.ok(script.includes(`--plugin-dir ${dir}`), `Claude in WSL takes the in-distro copy: ${script}`)
  }
  assert.ok(script.includes(`cd '${toWslPath(cwd)}'`), script)
  assert.ok(!script.includes('\r'), 'the startup script bash reads has LF line endings')
})

test('a WSL startup script lives in the helper directory inside the distribution, never behind /mnt', () => {
  const cwd = join(temp, 'workspace-session-dir')
  mkdirSync(cwd, { recursive: true })
  const config = launchInWsl(cwd, 'sid/odd name', { kind: 'wsl', distro: 'Ubuntu', env: {} })
  const path = config.startupScriptPath ?? ''
  assert.ok(path.startsWith(`${SESSION_DIR}/`), path)
  assert.match(path.slice(SESSION_DIR.length + 1), /^sid_odd_name-\d+\.sh$/u, 'a plain file name')
  assert.ok(
    !config.args.some((arg) => arg.startsWith('/mnt/')),
    `nothing is read through a drive mount: ${config.args}`,
  )
  assert.deepEqual(config.args.slice(-3), ['bash', '-li', path])
  assert.ok(scriptOf(config).endsWith('\n'))
})

test('a WSL launch with no helper directory says the helper is not running, and writes nothing here', () => {
  const cwd = join(temp, 'workspace-no-helper')
  mkdirSync(cwd, { recursive: true })
  assert.throws(
    () => launchInWsl(cwd, 'sid-none', { kind: 'wsl', distro: 'Ubuntu', env: {}, sessionDir: undefined }),
    /The WSL helper for Ubuntu is not running/u,
  )
  assert.throws(
    () => getPlainShellLaunchConfig(cwd, 'plain-none', { kind: 'wsl', distro: 'Ubuntu', env: {} }),
    /The WSL helper for Ubuntu is not running/u,
  )
})

test("a WSL agent's MCP channel token is exported by its startup script and by nothing else", () => {
  const cwd = join(temp, 'workspace-token')
  mkdirSync(cwd, { recursive: true })
  const token = 'tok_0123456789abcdefABCDEF'
  const config = launchInWsl(cwd, 'sid-token', {
    kind: 'wsl',
    distro: 'Ubuntu',
    env: {},
    integration: INTEGRATION,
    identity: { SPRINTENGINE_AGENT_ID: 'agent-t' },
    channelToken: token,
  })
  assert.ok(scriptOf(config).includes(`export SPRINTENGINE_MCP_CHANNEL_TOKEN='${token}'`), scriptOf(config))
  assert.ok(!config.args.some((arg) => arg.includes(token)), 'not on the command line')
  assert.ok(!Object.values(config.env ?? {}).includes(token), 'not in the Windows environment')
  const without = launchInWsl(cwd, 'sid-token-2', { kind: 'wsl', distro: 'Ubuntu', env: {} })
  assert.ok(!scriptOf(without).includes('SPRINTENGINE_MCP_CHANNEL_TOKEN'), 'a launch without one exports none')
})

test("a WSL agent's host-context document goes into the distribution with its script", () => {
  const cwd = join(temp, 'workspace-context')
  mkdirSync(join(cwd, 'design-system'), { recursive: true })
  const config = launchInWsl(cwd, 'sid-context', { kind: 'wsl', distro: 'Ubuntu', env: {}, integration: INTEGRATION })
  const contextPath = config.hostContextPath ?? ''
  assert.ok(contextPath.startsWith(`${SESSION_DIR}/host-context-`), contextPath)
  const file = config.hostFiles?.find((entry) => entry.path === contextPath)
  assert.ok(file, 'the document is one of the host files')
  assert.ok(file.content.includes(toWslPath(join(cwd, 'design-system'))), 'its paths are as Linux names them')
  assert.ok(scriptOf(config).includes(contextPath), 'the CLI is pointed at the Linux path')
})

test('a WSL agent whose helper has not written the plugin copy gets no --plugin-dir', () => {
  const cwd = join(temp, 'workspace-no-copy')
  mkdirSync(cwd, { recursive: true })
  const config = launchInWsl(cwd, 'sid-wsl-2', {
    kind: 'wsl',
    distro: 'Ubuntu',
    env: {},
    integration: { ...INTEGRATION, pluginDirs: [] },
    identity: { SPRINTENGINE_AGENT_ID: 'agent-2' },
  })
  assert.ok(!scriptOf(config).includes('--plugin-dir'), scriptOf(config))
})

test('a WSL launch in a folder inside a distribution runs in that distribution', () => {
  __setDefaultWslDistroForTest('Debian')
  try {
    const script = `${SESSION_DIR}/s1-1.sh`
    assert.deepEqual(wslStartupArgs('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', script), [
      '-d',
      'Ubuntu',
      '-e',
      'bash',
      '-li',
      script,
    ])
    assert.deepEqual(wslStartupArgs('\\\\wsl$\\Ubuntu-24.04\\srv\\app', script).slice(0, 2), ['-d', 'Ubuntu-24.04'])
    // Any other folder runs in the default distribution, by name.
    assert.deepEqual(wslStartupArgs('C:\\Users\\dev\\repo', script).slice(0, 2), ['-d', 'Debian'])
  } finally {
    __resetWslHostForTest()
  }
  // Before the default is known, no `-d`: that is the default distribution.
  assert.equal(wslStartupArgs('C:\\Users\\dev\\repo', `${SESSION_DIR}/s.sh`)[0], '-e')
})

test('an agent launched through WSL names the distribution and records its shell pid', () => {
  const cwd = join(temp, 'workspace-distro')
  mkdirSync(cwd, { recursive: true })
  __setDefaultWslDistroForTest('Debian')
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  let config: ReturnType<typeof getShellLaunchConfig>
  try {
    config = launchInWsl(cwd, 'sid-distro', { kind: 'wsl', distro: null, env: {} })
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform)
    __resetWslHostForTest()
  }
  assert.deepEqual(config.args.slice(0, 2), ['-d', 'Debian'])
  const script = scriptOf(config)
  const key = wslSessionPidKey(config.startupScriptPath)
  assert.ok(key, 'the startup script path gives a pid key')
  assert.ok(script.startsWith(wslSessionPidFileCommand(PID_DIR, key)), script)
  assert.ok(script.includes(`'${PID_DIR}'`), "into the helper's private directory")
})

test("a launch on a WSL machine runs in the machine's distribution, whatever folder it opens", () => {
  const cwd = join(temp, 'workspace-machine')
  mkdirSync(cwd, { recursive: true })
  __setDefaultWslDistroForTest('Debian')
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  let config: ReturnType<typeof getShellLaunchConfig>
  try {
    config = launchInWsl(cwd, 'sid-machine', {
      kind: 'wsl',
      distro: 'Ubuntu',
      env: { NODE_OPTIONS: "--max-old-space-size=4096 --title='x'", 'bad-name': 'nope' },
      shell: 'zsh -l',
    })
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform)
    __resetWslHostForTest()
  }
  assert.deepEqual(config.args.slice(0, 2), ['-d', 'Ubuntu'], 'the machine, not the default distribution')
  const script = scriptOf(config)
  assert.ok(script.includes(`export NODE_OPTIONS='--max-old-space-size=4096 --title='"'"'x'"'"''`), script)
  assert.ok(!script.includes('bad-name'), 'a name no shell can export is left out')
  assert.ok(script.trimEnd().endsWith('exec zsh -l'), 'the tab ends in the machine shell')
  // The machine's environment comes before the launch's own exports, so a
  // provider's endpoint still wins over a machine-wide default.
  assert.ok(script.indexOf('export NODE_OPTIONS') < script.indexOf(`cd '`), script)
})

test('a plain terminal on a WSL machine opens in its distribution with its shell', () => {
  const cwd = join(temp, 'workspace-plain')
  mkdirSync(cwd, { recursive: true })
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  let config: ReturnType<typeof getPlainShellLaunchConfig>
  try {
    config = getPlainShellLaunchConfig(cwd, 'plain-machine', {
      kind: 'wsl',
      distro: 'Ubuntu',
      env: { A: '1' },
      sessionDir: SESSION_DIR,
      pidDir: PID_DIR,
    })
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform)
  }
  assert.equal(config.command, 'wsl.exe')
  assert.equal(config.pathStyle, 'wsl')
  assert.deepEqual(config.args.slice(0, 2), ['-d', 'Ubuntu'])
  assert.ok(config.startupScriptPath?.startsWith(`${SESSION_DIR}/`), String(config.startupScriptPath))
  const script = scriptOf(config)
  assert.ok(script.includes("export A='1'"), script)
  assert.ok(script.trimEnd().endsWith('exec bash -li'), 'no configured shell: a login bash, as always')
})

test('a WSL startup script, run by a real bash, records its pid, deletes itself, and still runs to the end', () => {
  const cwd = join(temp, 'workspace-selfdelete')
  const sessionDir = join(temp, 'sessions-real')
  const pidDir = join(temp, 'pids-real')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  mkdirSync(pidDir, { recursive: true, mode: 0o700 })
  const marker = join(temp, 'ran-to-the-end')
  const config = getPlainShellLaunchConfig(cwd, 'plain-real', {
    kind: 'wsl',
    distro: 'Ubuntu',
    // A long export, so the one line is well past any single read bash makes.
    // Under Linux's 128 KiB cap on one environment string (MAX_ARG_STRLEN):
    // past it, the script's final `exec` fails with E2BIG, which is a limit of
    // the kernel, not of the script.
    env: { PADDING: 'x'.repeat(100_000) },
    shell: `sh -c 'touch "${marker}"'`,
    sessionDir,
    pidDir,
  })
  const script = scriptOf(config)
  const path = config.startupScriptPath ?? ''
  writeFileSync(path, script, { mode: 0o600 })
  execFileSync('bash', [path], { cwd, env: { PATH: process.env.PATH, HOME: temp } })
  assert.equal(existsSync(path), false, 'the script, and the secrets in it, are gone once read')
  assert.equal(existsSync(marker), true, 'everything after the delete still ran')
  const key = wslSessionPidKey(path) ?? ''
  assert.ok(existsSync(join(pidDir, `${key}.pid`)), 'the pid was recorded first')
})

test("the person's own MCP servers are handed to a CLI in WSL with Linux paths", () => {
  const base: Pick<McpServerConfig, 'enabled' | 'clients' | 'scope' | 'source' | 'riskLevel'> = {
    enabled: true,
    clients: ['claude-code'],
    scope: 'workspace',
    source: 'custom',
    riskLevel: 'local-command',
  }
  const { servers, warnings } = mcpServersForWsl({
    files: {
      ...base,
      id: 'files',
      name: 'Files',
      transport: 'stdio',
      command: 'C:\\tools\\mcp\\files-server',
      args: ['--root', 'C:\\Users\\dev\\notes', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\cfg.json', '--flag'],
    },
    npx: { ...base, id: 'npx', name: 'Npx', transport: 'stdio', command: 'npx', args: ['-y', '@acme/mcp'] },
    exe: { ...base, id: 'exe', name: 'Windows only', transport: 'stdio', command: 'C:\\tools\\server.exe' },
    web: { ...base, id: 'web', name: 'Web', transport: 'http', url: 'https://example.com/mcp' },
  })
  assert.equal(servers.files.command, '/mnt/c/tools/mcp/files-server')
  assert.deepEqual(servers.files.args, ['--root', '/mnt/c/Users/dev/notes', '/home/dev/cfg.json', '--flag'])
  assert.deepEqual(servers.npx, {
    ...base,
    id: 'npx',
    name: 'Npx',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@acme/mcp'],
  })
  assert.equal(servers.web.url, 'https://example.com/mcp')
  assert.equal(servers.exe.command, '/mnt/c/tools/server.exe', 'still written, so interop can start it')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /Windows only.*WSL interop/u)
})

// OpenCode loads its reporter in-process, so the socket is baked into the
// plugin file. In WSL that is the helper's Unix socket, which OpenCode (a
// Linux process) can open; this machine's named pipe it could not.
test("OpenCode in WSL gets the helper's Unix socket baked into its plugin", async () => {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'resources', 'plugins', 'opencode', 'plugin.json'), 'utf8'),
  ) as { agentStateSpec: PluginAgentStateSpec }
  const root = join(temp, 'opencode-wsl')
  mkdirSync(root, { recursive: true })
  const service = createAgentStateService({
    resolveUserDataDir: () => join(temp, 'ud-opencode'),
    resolveAgentStateSpec: (cli) => (cli === 'opencode' ? manifest.agentStateSpec : null),
    resolveReporterScriptPath: () => null,
    resolveReporterTemplatePath: (template) => join(process.cwd(), 'resources', 'hooks', template),
    onFrame: () => undefined,
  })
  await service.installForWorkspace(root, 'opencode', {
    pathStyle: 'wsl',
    hostId: 'wsl:Ubuntu',
    integration: INTEGRATION,
  })
  const plugin = readFileSync(join(root, '.opencode', 'plugin', 'sprintengine-agent-state.js'), 'utf8')
  assert.ok(plugin.includes(JSON.stringify(SOCK)), 'the Unix socket is baked in')
  assert.ok(plugin.includes(`const BAKED_SOCKET = ${JSON.stringify(SOCK)}`), 'the baked socket is the helper one')
})
