import assert from 'node:assert/strict'
import { test } from 'vitest'

import { ceilingAllowsUnaskedTools, clampPresetToCeiling } from './permission-ceiling'

test('a preset looser than the ceiling is lowered to it, and a stricter one is kept', () => {
  assert.equal(clampPresetToCeiling('bypass', 'auto'), 'auto')
  assert.equal(clampPresetToCeiling('manual', 'auto'), 'manual')
  assert.equal(clampPresetToCeiling('auto', 'auto'), 'auto')
})

test('no preset asked for is pinned to a ceiling below the loosest, since the default could be looser', () => {
  assert.equal(clampPresetToCeiling(undefined, 'auto'), 'auto')
  assert.equal(clampPresetToCeiling(undefined, 'bypass'), undefined)
})

test('no ceiling leaves the request as it is', () => {
  assert.equal(clampPresetToCeiling('bypass', null), 'bypass')
  assert.equal(clampPresetToCeiling(undefined, null), undefined)
})

test('tools may be allowed unasked only under the loosest ceiling, and only for an uncapped caller', () => {
  assert.equal(ceilingAllowsUnaskedTools('bypass'), true)
  assert.equal(ceilingAllowsUnaskedTools('auto'), false)
  assert.equal(ceilingAllowsUnaskedTools('bypass', 'auto'), false)
  assert.equal(ceilingAllowsUnaskedTools('bypass', 'bypass'), true)
})
