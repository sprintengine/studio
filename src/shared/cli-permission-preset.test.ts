import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  CLI_PERMISSION_PRESETS,
  isLooserCliPermissionPreset,
  isMostPermissiveCliPermissionPreset,
  normalizeCliPermissionPreset,
  parseCliPermissionPreset,
} from './cli-permission-preset'

test('the presets rank manual, none, auto, bypass from strictest to loosest', () => {
  assert.deepEqual(CLI_PERMISSION_PRESETS, ['manual', 'none', 'auto', 'bypass'])
  assert.equal(isLooserCliPermissionPreset('bypass', 'none'), true)
  assert.equal(isLooserCliPermissionPreset('bypass', 'auto'), true)
  assert.equal(isLooserCliPermissionPreset('auto', 'none'), true)
  assert.equal(isLooserCliPermissionPreset('none', 'manual'), true)
  assert.equal(isLooserCliPermissionPreset('none', 'bypass'), false)
  assert.equal(isLooserCliPermissionPreset('manual', 'auto'), false)
})

test('a preset is not looser than itself', () => {
  for (const preset of CLI_PERMISSION_PRESETS) assert.equal(isLooserCliPermissionPreset(preset, preset), false)
})

test('bypass is the most permissive preset and no other is', () => {
  assert.equal(isMostPermissiveCliPermissionPreset('bypass'), true)
  for (const preset of ['none', 'manual', 'auto'] as const)
    assert.equal(isMostPermissiveCliPermissionPreset(preset), false)
})

test('the four presets read as themselves', () => {
  for (const preset of CLI_PERMISSION_PRESETS) assert.equal(parseCliPermissionPreset(preset), preset)
})

test('retired spellings read as the mode that kept their promise', () => {
  assert.equal(parseCliPermissionPreset('default'), 'manual')
  assert.equal(parseCliPermissionPreset('auto_workspace'), 'auto')
  assert.equal(parseCliPermissionPreset('bypass_all'), 'bypass')
})

test('a value no version wrote is not a preset, and only normalizing gives it the default', () => {
  assert.equal(parseCliPermissionPreset('yolo'), null)
  assert.equal(parseCliPermissionPreset(undefined), null)
  assert.equal(normalizeCliPermissionPreset('yolo'), 'bypass')
  assert.equal(normalizeCliPermissionPreset('manual'), 'manual')
})
