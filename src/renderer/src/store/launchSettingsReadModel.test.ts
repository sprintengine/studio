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
    lastAgentSpawnPermissionPreset: 'manual' as const,
  }
  const effective = effectiveAgentLaunchSettings(stored)
  const shown = withLaunchSettings(defaultAppSettings(), stored, [])
  assert.equal(effective.lastSelectedCli, 'codex')
  assert.equal(shown.lastSelectedCli, 'codex')
  assert.equal(effective.lastAgentSpawnPermissionPreset, 'manual')
  assert.equal(shown.lastAgentSpawnPermissionPreset, 'manual')
})

test('a stored preset that is present but not current never escalates to the default', () => {
  // A legacy spelling keeps its meaning and an unrecognised value floors to
  // manual, as the window's own normalizer does, instead of reading as "never
  // chosen" and so as the bypass default.
  const legacy = normalizeAgentLaunchSettings({ lastAgentSpawnPermissionPreset: 'default' })
  assert.equal(effectiveAgentLaunchSettings(legacy).lastAgentSpawnPermissionPreset, 'manual')
  assert.equal(withLaunchSettings(defaultAppSettings(), legacy, []).lastAgentSpawnPermissionPreset, 'manual')
  const corrupt = normalizeAgentLaunchSettings({ lastAgentSpawnPermissionPreset: 'root' })
  assert.equal(effectiveAgentLaunchSettings(corrupt).lastAgentSpawnPermissionPreset, 'manual')
  assert.equal(normalizeAgentLaunchSettings({}).lastAgentSpawnPermissionPreset, null)
})
