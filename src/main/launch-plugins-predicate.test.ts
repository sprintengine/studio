// Three places decide whether a launch carries the app's own plugin copy: the
// launch flag (`--plugin-dir`), the agent-state installer and the workspace
// plugin installer. They must give one answer. When the workspace installer
// read only "has the copy landed" while the launch also asked "does this
// platform take it", Windows fell between them: the copy landed, the installer
// took the workspace hook out, and the launch passed no flag, so Claude there
// reported no agent state at all.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, test, vi } from 'vitest'

import type { SkillHarness } from '../shared/skills'
import { createPluginRegistry } from './plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from './plugin-registry-instance'
import { createStudioPluginService } from './studio-plugin-service'
import {
  appLaunchPluginsActive,
  cleanupTerminalStartupScript,
  getShellLaunchConfig,
  launchCarriesAppPluginsFor,
  setLaunchPluginDirsResolver,
} from './terminal-launch'

vi.mock('electron', () => import('../../tests/stubs/electron'))

const PLUGIN_DIRS = ['C:\\Users\\dev\\AppData\\Roaming\\sprintengine-studio\\agent-integration\\1\\plugin']

let temp = ''

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'se-launch-plugins-'))
  __resetPluginRegistryForTest()
  const registry = createPluginRegistry({
    bundledRoot: join(process.cwd(), 'resources', 'plugins'),
    userRoot: join(temp, 'no-user-plugins'),
  })
  __setPluginRegistryForTest(registry, registry.loadSync())
})

afterAll(() => {
  setLaunchPluginDirsResolver(null)
  __resetPluginRegistryForTest()
  rmSync(temp, { recursive: true, force: true })
})

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    return run()
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

test('on Windows the plugin copy is never active for launches, landed or not', () => {
  assert.equal(appLaunchPluginsActive(PLUGIN_DIRS, 'win32'), false)
  assert.equal(launchCarriesAppPluginsFor('claude-code', PLUGIN_DIRS, 'win32'), false)
})

test('elsewhere it is active once the copy has landed', () => {
  assert.equal(appLaunchPluginsActive(['/Users/dev/plugin'], 'darwin'), true)
  assert.equal(appLaunchPluginsActive([], 'darwin'), false, 'no copy yet: the workspace install still runs')
  assert.equal(launchCarriesAppPluginsFor('claude-code', ['/Users/dev/plugin'], 'linux'), true)
})

test('a Windows launch passes no --plugin-dir, which is what the workspace installer is told', () => {
  setLaunchPluginDirsResolver(() => PLUGIN_DIRS)
  const cwd = join(temp, 'workspace-launch')
  mkdirSync(cwd, { recursive: true })
  for (const useWsl of [false, true]) {
    let config: ReturnType<typeof getShellLaunchConfig> | undefined
    try {
      config = withPlatform('win32', () =>
        getShellLaunchConfig(cwd, 'sid-plugins', false, 'claude-code', undefined, {
          'claude-code': { command: 'claude', useWsl },
        }),
      )
    } catch (error) {
      // The native branch refuses a POSIX temp dir as a Windows path; the
      // flag decision under test is the WSL one there.
      if (!useWsl && /not available as a Windows path/u.test(String(error))) continue
      throw error
    }
    try {
      const script = readFileSync(config.startupScriptPath ?? '', 'utf8')
      assert.doesNotMatch(script, /--plugin-dir/u, `useWsl=${useWsl}`)
    } finally {
      cleanupTerminalStartupScript(config.startupScriptPath)
    }
  }
  setLaunchPluginDirsResolver(null)
})

test('on Windows the workspace keeps its Claude hook when the plugin copy has landed', async () => {
  const workspace = join(temp, 'workspace-install')
  const userData = join(temp, 'userData')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(userData, { recursive: true })
  const reporter = join(temp, 'sprintengine-agent-state.mjs')
  writeFileSync(reporter, '// reporter\n', 'utf8')
  const service = createStudioPluginService({
    resolveTemplateRoot: () => resolve(process.cwd(), 'resources', 'studio-plugin'),
    resolveAgentStateReporterPath: () => reporter,
    resolveBridgeScriptPath: () => join(temp, 'mcp-stdio-bridge.mjs'),
    resolveNodeCommand: () => join(temp, 'Electron'),
    resolveUserDataDir: () => userData,
    resolveAgentStateSocketPath: () => join(userData, 'agent-state.sock'),
    listHarnesses: async (): Promise<SkillHarness[]> => ['agents', 'claude'],
    // Exactly what app-services wires, with the platform pinned to Windows.
    resolveLaunchPluginsActive: () => appLaunchPluginsActive(PLUGIN_DIRS, 'win32'),
  })
  await service.ensureInstalledForRoots([workspace])
  const record = service.installed(workspace)
  assert.ok(record?.hookSettingsPath, 'the Claude hook is registered in the workspace')
  assert.equal(existsSync(join(workspace, '.claude', 'settings.local.json')), true)
  assert.equal(existsSync(join(workspace, '.sprintengine', 'hooks', 'agent-state.mjs')), true)
})
