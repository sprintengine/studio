import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubEnv('PROD', true)
})

import { FEATURE_FLAGS, featureFlagsForBuild } from './featureFlags'

test('conversation mode is hidden from packaged builds', () => {
  assert.equal(FEATURE_FLAGS.conversationMode, false)
  assert.equal(featureFlagsForBuild(true).conversationMode, false)
  assert.equal(featureFlagsForBuild(false).conversationMode, true)
})
