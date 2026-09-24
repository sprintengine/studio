/**
 * The upgrade boot on a machine whose userData cannot be written: main accepts
 * the window's migration offer but can only hold the record in memory, and
 * says so. The window must keep its localStorage copy of the launch fields,
 * since main's copy is gone at the next restart and the next boot has to offer
 * them again. Once a later write does reach disk, the copy is released.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createFakeLaunchSettingsMain, installFakeWindow, settleIpc } from './launchSettingsFakeMain.test-helper'
import { LAUNCH_SETTINGS_KEYS } from './launchSettingsReadModel'

const { APP_SETTINGS_STORAGE_KEY, WORKSPACE_STORE_VERSION } = await import('./slices/persistenceSlice')

const fakeMain = createFakeLaunchSettingsMain()
fakeMain.setDiskWritable(false)
const stored = installFakeWindow(fakeMain.api, {
  [APP_SETTINGS_STORAGE_KEY]: JSON.stringify({
    state: {
      appSettings: {
        cliRuntimes: { codex: { command: '/Users/dev/bin/codex' } },
        lastSelectedCli: 'codex',
        lastAgentSpawnPermissionPreset: 'manual',
        telemetryEnabled: false,
      },
    },
    version: WORKSPACE_STORE_VERSION,
  }),
})

const { useWorkspaceStore, launchSettingsReady } = await import('./workspaceStore')

function persistedAppSettings(): Record<string, unknown> {
  const raw = stored.get(APP_SETTINGS_STORAGE_KEY)
  assert.ok(raw, 'the settings envelope exists')
  return (JSON.parse(raw) as { state: { appSettings: Record<string, unknown> } }).state.appSettings
}

test('a migration main could not save leaves the launch fields in localStorage', async () => {
  await launchSettingsReady
  await settleIpc()
  assert.equal(fakeMain.calls.migrate.length, 1, 'the window offered its values')
  assert.equal(fakeMain.record()?.settings.lastSelectedCli, 'codex', 'main holds them in memory')
  assert.equal(useWorkspaceStore.getState().appSettings.lastSelectedCli, 'codex', 'and the window shows them')

  const appSettings = persistedAppSettings()
  assert.equal(appSettings.lastSelectedCli, 'codex', 'the copy stays for the next boot to offer')
  assert.equal(appSettings.lastAgentSpawnPermissionPreset, 'manual')

  // An unrelated settings write carries the copy forward rather than dropping it.
  useWorkspaceStore.getState().setSidebarCollapsed(true)
  await settleIpc()
  assert.equal(persistedAppSettings().lastSelectedCli, 'codex')
})

test('an update that reaches disk releases the copy', async () => {
  fakeMain.setDiskWritable(true)
  useWorkspaceStore.getState().setLastSelectedCli('gemini')
  await settleIpc()
  const appSettings = persistedAppSettings()
  for (const key of LAUNCH_SETTINGS_KEYS) assert.equal(Object.hasOwn(appSettings, key), false, key)
  assert.equal(appSettings.telemetryEnabled, false, 'the settings the window owns stay')
})
