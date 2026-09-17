import assert from 'node:assert/strict'

import { BUNDLED_MODULE_IDS, CANVAS_MODULE_DEFAULT_ENABLED } from '../../../shared/modules/manifest'
import { BUNDLED_RENDERER_MODULE_MANIFESTS } from './index'

// Drift guard: BUNDLED_MODULE_IDS (the shared reserved-id list a third-party
// module may not shadow) must cover every bundled renderer module manifest —
// which carries every capability id (the main list is a subset). If a bundled
// module is added or renamed without updating BUNDLED_MODULE_IDS, a
// third-party module could install under the real id; this test catches that.
//
// RESERVED-BUT-UNBUNDLED ids stay in BUNDLED_MODULE_IDS on purpose. A module id
// the app once shipped — or ships today as an installable module rather than an
// in-tree one — is still an id a person recognises and a first-party trust
// decision keys on (`isFirstPartyAutomationProviderModule`), so releasing it
// back into the third-party namespace would let an impostor inherit that trust.
// `review` is the extracted Reviews module and `sprint-engine` the extracted
// Sprint Engine (both publisher-locked reservations); the others are retired.
// They are listed here, not silently tolerated, so the set stays deliberate.
const RETIRED_RESERVED_IDS = ['switchboard', 'design-wizard', 'review', 'sprint-engine']

const bundled = [...BUNDLED_RENDERER_MODULE_MANIFESTS.map((m) => m.id)].sort()
const reserved = [...BUNDLED_MODULE_IDS].sort()
assert.deepEqual(
  reserved.filter((id) => !RETIRED_RESERVED_IDS.includes(id)),
  bundled,
  'BUNDLED_MODULE_IDS must match the bundled renderer module ids, plus the reserved-but-unbundled ids',
)
for (const id of RETIRED_RESERVED_IDS) {
  assert.ok(reserved.includes(id), `reserved module id "${id}" must stay reserved`)
  assert.ok(!bundled.includes(id), `reserved module id "${id}" must not be a live bundled module`)
}

// The same drift guard for the one manifest field main has to read without
// importing the renderer: the canvas tools answer on the shared default until a
// window's registry mirror carries an entry, so the two must be the same value.
const canvasManifest = BUNDLED_RENDERER_MODULE_MANIFESTS.find((manifest) => manifest.id === 'canvas')
assert.ok(canvasManifest, 'the canvas module is bundled')
assert.equal(
  canvasManifest.defaultEnabled,
  CANVAS_MODULE_DEFAULT_ENABLED,
  'CANVAS_MODULE_DEFAULT_ENABLED is what main answers on before a window has spoken',
)

console.log('bundled-ids guard passed')
