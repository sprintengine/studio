import assert from 'node:assert/strict'

import { BUNDLED_MODULE_IDS } from '../../../shared/modules/manifest'
import { BUNDLED_RENDERER_MODULE_MANIFESTS } from './index'

// Drift guard: BUNDLED_MODULE_IDS (the shared reserved-id list a third-party
// module may not shadow) must exactly match the bundled renderer module
// manifests — which carry every capability id (the main list is a subset).
// If a bundled module is added/renamed without updating BUNDLED_MODULE_IDS, a
// third-party module could install under the real id; this test catches that.
const bundled = [...BUNDLED_RENDERER_MODULE_MANIFESTS.map((m) => m.id)].sort()
const reserved = [...BUNDLED_MODULE_IDS].sort()
assert.deepEqual(reserved, bundled, 'BUNDLED_MODULE_IDS must match the bundled renderer module ids')

console.log('bundled-ids guard passed')
