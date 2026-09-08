import assert from 'node:assert/strict'

import { BUNDLED_MODULE_IDS } from '../../../shared/modules/manifest'
import { BUNDLED_RENDERER_MODULE_MANIFESTS } from './index'

// Drift guard: BUNDLED_MODULE_IDS (the shared reserved-id list a third-party
// module may not shadow) must cover every bundled renderer module manifest —
// which carries every capability id (the main list is a subset). If a bundled
// module is added or renamed without updating BUNDLED_MODULE_IDS, a
// third-party module could install under the real id; this test catches that.
//
// RETIRED ids stay reserved on purpose. A module id the app once shipped is
// still an id a person recognises and a first-party trust decision keys on
// (`isFirstPartyAutomationProviderModule`), so releasing it back into the
// third-party namespace would let an impostor inherit that trust. They are
// listed here, not silently tolerated, so the set stays deliberate.
const RETIRED_RESERVED_IDS = ['switchboard', 'design-wizard']

const bundled = [...BUNDLED_RENDERER_MODULE_MANIFESTS.map((m) => m.id)].sort()
const reserved = [...BUNDLED_MODULE_IDS].sort()
assert.deepEqual(
  reserved.filter((id) => !RETIRED_RESERVED_IDS.includes(id)),
  bundled,
  'BUNDLED_MODULE_IDS must match the bundled renderer module ids, plus the retired reserved ids',
)
for (const id of RETIRED_RESERVED_IDS) {
  assert.ok(reserved.includes(id), `retired module id "${id}" must stay reserved`)
  assert.ok(!bundled.includes(id), `retired module id "${id}" must not be a live bundled module`)
}

console.log('bundled-ids guard passed')
