import assert from 'node:assert/strict'

// Production-channel regression test. This bundle is built with
// `--define:import.meta.env.PROD=true` (the only test that does), so it
// exercises the real renderer module index down the production path: the
// dev-only modules must be excluded from the active set, the optional ids, and
// the enablement resolution, while the full bundled list (reserved-id source)
// stays complete.
import {
  ACTIVE_RENDERER_MODULE_MANIFESTS,
  BUNDLED_RENDERER_MODULE_MANIFESTS,
  COMING_SOON_MODULE_MANIFESTS,
  selectModuleEnabled,
} from './index'
import { DEV_ONLY_MODULE_IDS } from '../../../shared/modules/dev-only'

const activeIds = ACTIVE_RENDERER_MODULE_MANIFESTS.map((m) => m.id)

// 1. No dev-only module is active in a production build.
for (const id of DEV_ONLY_MODULE_IDS) {
  assert.ok(!activeIds.includes(id), `dev-only module "${id}" must be absent from the active set in production`)
}

// 1b. The feature-flagged modules surface as "Coming soon" rows in production —
//     exactly the dev-only set, no more, no less.
assert.deepEqual(
  [...COMING_SOON_MODULE_MANIFESTS.map((m) => m.id)].sort(),
  [...DEV_ONLY_MODULE_IDS].sort(),
  'coming-soon modules in production must be exactly the dev-only set'
)

// 2. The expected production survivors are present (sanity that we didn't drop
//    too much — agent-runtime + the non-dev-only bundled modules).
for (const id of ['agent-runtime', 'backlog', 'dev-tools', 'git', 'memory-graph', 'automations']) {
  assert.ok(activeIds.includes(id), `production build must keep "${id}"`)
}

// 3. selectModuleEnabled resolves a dev-only id as false in production, even
//    with an override that explicitly tries to turn it on (an absent module is
//    not in the universe, so it can never resolve enabled). This is what makes
//    the self-gating surfaces (top-bar mic, Voice/Mobile settings tabs) hide.
for (const id of DEV_ONLY_MODULE_IDS) {
  assert.equal(selectModuleEnabled({}, id), false, `${id} must be disabled with no overrides in production`)
  assert.equal(selectModuleEnabled({ [id]: true }, id), false, `${id} must stay disabled even if an override tries to enable it in production`)
}

// 4. The full bundled manifest list is NOT narrowed by the channel — it stays
//    complete so the reserved-id / anti-impersonation set covers every id even
//    in a build where the feature is absent.
const fullIds = BUNDLED_RENDERER_MODULE_MANIFESTS.map((m) => m.id)
for (const id of DEV_ONLY_MODULE_IDS) {
  assert.ok(fullIds.includes(id), `bundled manifest list must still contain "${id}" in production (reserved-id source)`)
}

console.log('dev-only production-channel gate passed')
