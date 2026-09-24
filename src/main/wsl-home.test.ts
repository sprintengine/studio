import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { PluginAgentStateSpec } from '../shared/plugin-manifest'
import { createAgentStateService } from './agent-state-service'
import type { HostAgentIntegration, HostHome } from './hosts/execution-host'
import { createWslHomeProbe } from './wsl-home'

test('the WSL home comes from the distribution host, as UNC paths, the default resolved to its name', async () => {
  const asked: string[] = []
  const probe = createWslHomeProbe({
    hostFor: (distro) => ({
      homeDir: async (): Promise<HostHome> => {
        asked.push(distro)
        return {
          host: '/home/dev',
          native: `\\\\wsl.localhost\\${distro}\\home\\dev`,
          env: { CLAUDE_CONFIG_DIR: `\\\\wsl.localhost\\${distro}\\home\\dev\\.claude-work` },
        }
      },
    }),
    resolveDefaultDistro: async () => 'Ubuntu',
  })
  assert.deepEqual(await probe(), {
    home: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
    root: '\\\\wsl.localhost\\Ubuntu',
    env: { CLAUDE_CONFIG_DIR: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.claude-work' },
  })
  assert.equal((await probe('Debian'))?.home, '\\\\wsl.localhost\\Debian\\home\\dev')
  assert.deepEqual(asked, ['Ubuntu', 'Debian'])
})

test('no default distribution, or a host that cannot answer, is no home', async () => {
  const none = createWslHomeProbe({
    hostFor: () => ({ homeDir: async () => assert.fail('nothing to ask') }),
    resolveDefaultDistro: async () => null,
  })
  assert.equal(await none(), null)
  const failing = createWslHomeProbe({
    hostFor: () => ({ homeDir: async () => null }),
    resolveDefaultDistro: async () => 'Ubuntu',
  })
  assert.equal(await failing(), null)
})

// Kimi's hook config is user-global. Run in WSL, the Kimi that reads it is a
// Linux process, so the file belongs in the distribution's home, and its hook
// runs the helper's Node and reports to the helper's socket. A temp dir stands
// in for `\\wsl.localhost\Ubuntu\home\dev`.
test('a WSL launch installs a user-scoped hook into the Linux home, a native one into the Windows home', async () => {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), 'resources', 'plugins', 'kimi-code', 'plugin.json'), 'utf8'),
  ) as { agentStateSpec: PluginAgentStateSpec }
  const windowsHome = await mkdtemp(join(tmpdir(), 'se-kimi-windows-home-'))
  const wslHome = await mkdtemp(join(tmpdir(), 'se-kimi-wsl-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'se-kimi-ws-'))
  const userData = await mkdtemp(join(tmpdir(), 'se-kimi-ud-'))
  const reporter = join(userData, 'agent-state.mjs')
  await writeFile(reporter, '// reporter\n', 'utf8')
  const service = createAgentStateService({
    resolveUserDataDir: () => userData,
    resolveAgentStateSpec: (cli) => (cli === 'kimi-code' ? manifest.agentStateSpec : null),
    resolveReporterScriptPath: () => reporter,
    resolveReporterTemplatePath: () => null,
    resolveHomeDir: () => windowsHome,
    onFrame: () => {},
  })

  // The helper was not up: nothing is written anywhere.
  await service.installForWorkspace(workspace, 'kimi-code', { pathStyle: 'wsl', hostId: 'wsl:Ubuntu' })
  assert.equal(existsSync(join(wslHome, '.kimi-code', 'config.toml')), false)
  assert.equal(existsSync(join(windowsHome, '.kimi-code', 'config.toml')), false)

  // With the helper: the config and the reporter copy land in the Linux home.
  const node = '/home/dev/.local/share/sprintengine-studio/runtime/node-v24.21.0/bin/node'
  const integration: HostAgentIntegration = {
    agentStateSocketPath: '/run/user/1000/sprintengine/abc123def456/agent.sock',
    commandRuntime: {
      executable: node,
      toCommandPath: (nativePath) => nativePath.replace(wslHome, '/home/dev').split('\\').join('/'),
    },
    pluginDirs: [],
    statusLineScriptPath: null,
    studioMcpEntry: { command: node, args: [], env: {} },
    home: { host: '/home/dev', native: wslHome },
  }
  await service.installForWorkspace(workspace, 'kimi-code', { pathStyle: 'wsl', hostId: 'wsl:Ubuntu', integration })
  const config = await readFile(join(wslHome, '.kimi-code', 'config.toml'), 'utf8')
  assert.ok(config.includes('event = "Stop"'), config)
  assert.ok(config.includes(node), 'the hook runs the pinned Linux Node')
  assert.ok(config.includes('/home/dev/.sprintengine/hooks/agent-state.mjs'), 'on the Linux path of the home copy')
  assert.ok(config.includes('/run/user/1000/sprintengine/abc123def456/agent.sock'), 'reporting to the helper')
  assert.ok(!config.includes('.exe'), 'no Windows program')
  assert.equal(existsSync(join(wslHome, '.sprintengine', 'hooks', 'agent-state.mjs')), true)
  assert.equal(existsSync(join(windowsHome, '.kimi-code', 'config.toml')), false)

  // Run natively, the same CLI's config is the Windows one.
  await service.installForWorkspace(workspace, 'kimi-code', { pathStyle: 'windows' })
  assert.equal(existsSync(join(windowsHome, '.kimi-code', 'config.toml')), true)
})
