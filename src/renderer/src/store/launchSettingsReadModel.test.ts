/**
 * The window's read model of main's launch settings and main's own launch
 * path must agree on what a never-chosen value means. Both go through
 * `effectiveAgentLaunchSettings`; this suite pins that the window shows
 * exactly what main would launch on, and that the stored record keeps `null`.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  effectiveAgentLaunchSettings,
  emptyAgentLaunchSettings,
  normalizeAgentLaunchSettings,
} from '../../../shared/launch-settings'
import { withLaunchSettings } from './launchSettingsReadModel'
import { defaultAppSettings } from './slices/settingsSlice'

test('a never-chosen CLI and preset read the same in the window as in main', () => {
  const stored = emptyAgentLaunchSettings()
  const effective = effectiveAgentLaunchSettings(stored)
  const shown = withLaunchSettings(defaultAppSettings(), stored, [])
  assert.equal(shown.lastSelectedCli, effective.lastSelectedCli)
  assert.equal(shown.lastAgentSpawnPermissionPreset, effective.lastAgentSpawnPermissionPreset)
  assert.equal(stored.lastSelectedCli, null, 'the record keeps never-chosen as null')
  assert.equal(stored.lastAgentSpawnPermissionPreset, null)
})

test('a chosen value is shown and launched as chosen', () => {
  const stored = {
    ...emptyAgentLaunchSettings(),
    lastSelectedCli: 'codex',
    lastAgentSpawnPermissionPreset: 'none' as const,
  }
  const effective = effectiveAgentLaunchSettings(stored)
  const shown = withLaunchSettings(defaultAppSettings(), stored, [])
  assert.equal(effective.lastSelectedCli, 'codex')
  assert.equal(shown.lastSelectedCli, 'codex')
  assert.equal(effective.lastAgentSpawnPermissionPreset, 'none')
  assert.equal(shown.lastAgentSpawnPermissionPreset, 'none')
})

test('a stored preset that asks never escalates to the default', () => {
  // Manual and Auto read as themselves, and each pre-rename spelling as the
  // preset its label promised, instead of reading as "never chosen" and so as
  // the bypass default. Only an absent value, or one no version wrote, takes it.
  for (const [stored, preset] of [
    ['manual', 'manual'],
    ['auto', 'auto'],
    ['default', 'manual'],
    ['auto_workspace', 'auto'],
  ] as const) {
    const legacy = normalizeAgentLaunchSettings({ lastAgentSpawnPermissionPreset: stored })
    assert.equal(effectiveAgentLaunchSettings(legacy).lastAgentSpawnPermissionPreset, preset, stored)
    assert.equal(withLaunchSettings(defaultAppSettings(), legacy, []).lastAgentSpawnPermissionPreset, preset, stored)
  }
  const corrupt = normalizeAgentLaunchSettings({ lastAgentSpawnPermissionPreset: 'root' })
  assert.equal(corrupt.lastAgentSpawnPermissionPreset, null)
  assert.equal(effectiveAgentLaunchSettings(corrupt).lastAgentSpawnPermissionPreset, 'auto')
  assert.equal(normalizeAgentLaunchSettings({}).lastAgentSpawnPermissionPreset, null)
})
