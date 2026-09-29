import assert from 'node:assert/strict'
import { test } from 'vitest'

import { isLooserCliPermissionPreset, isMostPermissiveCliPermissionPreset } from './cli-permission-preset'

test('bypass is looser than none', () => {
  assert.equal(isLooserCliPermissionPreset('bypass', 'none'), true)
  assert.equal(isLooserCliPermissionPreset('none', 'bypass'), false)
})

test('a preset is not looser than itself', () => {
  assert.equal(isLooserCliPermissionPreset('none', 'none'), false)
  assert.equal(isLooserCliPermissionPreset('bypass', 'bypass'), false)
})

test('bypass is the most permissive preset and none is not', () => {
  assert.equal(isMostPermissiveCliPermissionPreset('bypass'), true)
  assert.equal(isMostPermissiveCliPermissionPreset('none'), false)
})
