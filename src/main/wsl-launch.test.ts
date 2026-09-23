import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test, vi } from 'vitest'

import type { PluginAgentStateSpec } from '../shared/plugin-manifest'
import { AGENT_IDENTITY_ENV_KEYS } from '../shared/studio-env'
import { buildAgentStateReporterCommand, installAgentStateReporter } from './agent-state'
import { createMcpConfigService } from './mcp-config-service'
import { createPluginRegistry } from './plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from './plugin-registry-instance'
import { syncStudioMcpConfig } from './studio-mcp-sync'
import { applyAgentIdentityEnv, cleanupTerminalStartupScript, getShellLaunchConfig } from './terminal-launch'
import { mergeWslEnv, toWslPath, withWslSharedEnv, wslInteropEnv } from './wsl-interop'

vi.mock('electron', () => import('../../tests/stubs/electron'))

// Everything an agent run through WSL is handed has to make sense to a Linux
// process, and anything that process hands back to a Windows program has to
// make sense on the other side. None of it can run here, so these cases pin the
// strings the launch writes and, where a POSIX shell is the reader, run them
// through one.

const PIPE = '\\\\.\\pipe\\sprintengine-agent-state-abc'
const HOST_EXE = '/mnt/c/Program Files/SprintEngine Studio/SprintEngine Studio.exe'
// What the agent-state service hands the installer for a WSL launch.
const WSL_RUNTIME = {
  executable: HOST_EXE,
  env: wslInteropEnv({ ELECTRON_RUN_AS_NODE: '1' }, AGENT_IDENTITY_ENV_KEYS),
  wslInterop: true,
}
const WSL_SHARED = ['ELECTRON_RUN_AS_NODE', ...AGENT_IDENTITY_ENV_KEYS].join(':')

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

test('WSLENV keeps what it already shares and names each variable once', () => {
  assert.equal(mergeWslEnv(undefined, ['A', 'B']), 'A:B')
  assert.equal(mergeWslEnv('', ['A']), 'A')
  assert.equal(mergeWslEnv('USERPROFILE/p:A', ['A', 'B']), 'USERPROFILE/p:A:B')
  assert.equal(mergeWslEnv('A/u', ['A']), 'A/u', 'an entry with flags already names the variable')
})

test('the env handed to wsl.exe shares the names under whatever spelling WSLENV already has', () => {
  assert.deepEqual(withWslSharedEnv({ PATH: 'x' }, ['SPRINTENGINE_AGENT_ID']), {
    PATH: 'x',
    WSLENV: 'SPRINTENGINE_AGENT_ID',
  })
  assert.deepEqual(withWslSharedEnv({ WslEnv: 'USERPROFILE/p' }, ['SPRINTENGINE_AGENT_ID']), {
    WslEnv: 'USERPROFILE/p:SPRINTENGINE_AGENT_ID',
  })
})

test('the env a Windows program is started with through interop names itself in WSLENV', () => {
  assert.deepEqual(wslInteropEnv({ ELECTRON_RUN_AS_NODE: '1' }), {
    ELECTRON_RUN_AS_NODE: '1',
    WSLENV: 'ELECTRON_RUN_AS_NODE',
  })
  assert.deepEqual(wslInteropEnv({ A: '1' }, ['B', 'A']), { A: '1', WSLENV: 'A:B' })
  assert.deepEqual(wslInteropEnv({}), {})
})

test('a WSL hook command names its env in WSLENV and single-quotes the pipe', () => {
  const command = buildAgentStateReporterCommand(
    'C:/Users/dev/repo/.sprintengine/hooks/agent-state.mjs',
    PIPE,
    WSL_RUNTIME,
  )
  assert.equal(
    command,
    `env ELECTRON_RUN_AS_NODE='1' WSLENV='${WSL_SHARED}' '${HOST_EXE}' ` +
      `'C:/Users/dev/repo/.sprintengine/hooks/agent-state.mjs' --socket '${PIPE}'`,
  )
  // Native launches are unchanged.
  assert.equal(
    buildAgentStateReporterCommand('C:/Users/dev/repo/.sprintengine/hooks/agent-state.mjs', PIPE),
    `node "C:/Users/dev/repo/.sprintengine/hooks/agent-state.mjs" --socket "${PIPE}"`,
  )
})

test('a POSIX shell running the WSL hook command hands the host runtime the pipe and the env intact', () => {
  // Stand in for the Windows runtime with a script that reports what it was
  // given, and let the shell a Linux CLI uses for its hooks run the command.
  const recorder = join(temp, 'Host Runtime.sh')
  writeFileSync(recorder, '#!/bin/sh\nprintf "%s\\n" "$ELECTRON_RUN_AS_NODE" "$WSLENV" "$@"\n', 'utf8')
  chmodSync(recorder, 0o755)
  const command = buildAgentStateReporterCommand('C:/Users/dev/repo/.sprintengine/hooks/agent-state.mjs', PIPE, {
    ...WSL_RUNTIME,
    executable: recorder,
  })
  const run = (env: NodeJS.ProcessEnv): string[] =>
    execFileSync('/bin/sh', ['-c', command], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' })
      .trimEnd()
      .split('\n')

  // The session's own WSLENV (what the launch shared into WSL) is replaced for
  // this one process by a list that still names the agent identity.
  const [runAsNode, wslEnv, script, flag, socket] = run({ WSLENV: 'SPRINTENGINE_AGENT_ID' })
  assert.equal(runAsNode, '1')
  assert.equal(wslEnv, WSL_SHARED)
  assert.equal(script, 'C:/Users/dev/repo/.sprintengine/hooks/agent-state.mjs')
  assert.equal(flag, '--socket')
  assert.equal(socket, PIPE, 'the named pipe keeps both leading backslashes')
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
  const options = { sourceScriptPath: reporter, socketPath: PIPE, homeDir: temp, commandRuntime: WSL_RUNTIME }
  assert.equal((await installAgentStateReporter(root, CURSOR_LIKE_SPEC, options)).ok, true)
  assert.equal((await installAgentStateReporter(root, CURSOR_LIKE_SPEC, options)).ok, true)
  const hooks = JSON.parse(readFileSync(join(root, '.cursor', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ command: string }>>
  }
  assert.equal(hooks.hooks.sessionStart.length, 1, JSON.stringify(hooks))
  assert.ok(hooks.hooks.sessionStart[0].command.startsWith('env ELECTRON_RUN_AS_NODE='))
})

const CLAUDE_LIKE_SPEC: PluginAgentStateSpec = {
  registration: { kind: 'settings-json', path: '.claude/settings.local.json' },
  statusLine: true,
  events: [{ event: 'SessionStart', phase: 'starting' }],
}

test("through WSL a person's own status line is left for the Linux shell that runs it", async () => {
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
    socketPath: PIPE,
    homeDir: join(temp, 'home'),
    env: { CLAUDE_CONFIG_DIR: join(temp, 'claude-config') },
    commandRuntime: WSL_RUNTIME,
  })
  assert.equal(result.ok, true)
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8')) as {
    statusLine: unknown
    hooks: Record<string, unknown>
  }
  assert.deepEqual(settings.statusLine, theirs)
  assert.ok(settings.hooks.SessionStart, 'the hooks are still installed')
})

test('the MCP gateway written for a WSL launch shares its env with the Windows runtime', async () => {
  const root = join(temp, 'mcp-wsl')
  mkdirSync(root, { recursive: true })
  const service = createMcpConfigService({ homeDir: () => join(temp, 'home'), userDataDir: () => join(temp, 'ud') })
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
        command: 'C:\\Program Files\\SprintEngine Studio\\SprintEngine Studio.exe',
        bridgeScriptPath: 'C:\\Program Files\\SprintEngine Studio\\resources\\mcp-stdio-bridge.mjs',
        userDataDir: 'C:\\Users\\dev\\AppData\\Roaming\\sprintengine-studio',
      }),
    },
  )
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  const config = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
  }
  const gateway = Object.values(config.mcpServers).find((server) => server.env?.ELECTRON_RUN_AS_NODE === '1')
  assert.ok(gateway, JSON.stringify(config))
  assert.equal(gateway.command, HOST_EXE)
  // Opened by the Windows runtime, so they stay Windows paths.
  assert.deepEqual(gateway.args, ['C:\\Program Files\\SprintEngine Studio\\resources\\mcp-stdio-bridge.mjs'])
  assert.equal(gateway.env.SPRINTENGINE_USER_DATA_DIR, 'C:\\Users\\dev\\AppData\\Roaming\\sprintengine-studio')
  const shared = gateway.env.WSLENV.split(':')
  for (const name of ['ELECTRON_RUN_AS_NODE', 'SPRINTENGINE_USER_DATA_DIR', ...AGENT_IDENTITY_ENV_KEYS]) {
    assert.ok(shared.includes(name), `${name} crosses to the Windows runtime: ${gateway.env.WSLENV}`)
  }
})

test('the MCP gateway written for a native launch carries no WSLENV', async () => {
  const root = join(temp, 'mcp-native')
  mkdirSync(root, { recursive: true })
  const service = createMcpConfigService({ homeDir: () => join(temp, 'home'), userDataDir: () => join(temp, 'ud') })
  const result = await syncStudioMcpConfig(
    { workspaceRoot: root, settings: { syncEnabled: false, servers: {} }, clients: ['claude-code'] },
    {
      mcpConfigService: service,
      studioGateway: () => ({
        command: '/Applications/Studio',
        bridgeScriptPath: '/b.mjs',
        userDataDir: '/Users/dev/ud',
      }),
    },
  )
  assert.equal(result.ok, true)
  assert.doesNotMatch(readFileSync(join(root, '.mcp.json'), 'utf8'), /WSLENV/u)
})

test('an agent launched through WSL shares its identity with the Linux side', () => {
  const cwd = join(temp, 'workspace')
  mkdirSync(cwd, { recursive: true })
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  let config: ReturnType<typeof getShellLaunchConfig>
  try {
    config = getShellLaunchConfig(cwd, 'sid-wsl', false, 'claude-code', 'hello', {
      'claude-code': { command: 'claude', useWsl: true },
    })
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform)
  }
  try {
    assert.equal(config.command, 'wsl.exe')
    assert.equal(config.pathStyle, 'wsl')
    assert.equal(config.args.at(-1), toWslPath(config.startupScriptPath ?? ''))
    const shared = (config.env?.WSLENV ?? '').split(':')
    for (const name of AGENT_IDENTITY_ENV_KEYS) assert.ok(shared.includes(name), `${name} is in WSLENV`)
    // The spawn applies the identity on top of this env; the list survives it.
    const spawned = applyAgentIdentityEnv(config.env ?? {}, {
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      cli: 'claude-code',
    })
    assert.equal(spawned.WSLENV, config.env?.WSLENV)
    assert.equal(spawned.SPRINTENGINE_AGENT_ID, 'agent-1')
    const script = readFileSync(config.startupScriptPath ?? '', 'utf8')
    assert.ok(script.includes(`cd '${toWslPath(cwd)}'`), script)
    assert.ok(!script.includes('\r'), 'the startup script bash reads has LF line endings')
  } finally {
    cleanupTerminalStartupScript(config.startupScriptPath)
  }
})
