import assert from 'node:assert/strict'

import { BUNDLED_MODULE_IDS } from './manifest'
import { DEV_ONLY_MODULE_IDS, isDevOnlyModule, activeForChannel } from './dev-only'

// The dev-only ids are the surfaces gated out of production builds.
assert.deepEqual(
  [...DEV_ONLY_MODULE_IDS].sort(),
  ['mobile-relay', 'multiloop', 'review', 'roadmap', 'switchboard', 'voice-dictation'],
  'dev-only ids must be exactly the gated surfaces'
)

// Every dev-only id must be a real bundled module id — a typo here would
// silently gate nothing.
for (const id of DEV_ONLY_MODULE_IDS) {
  assert.ok(
    BUNDLED_MODULE_IDS.includes(id),
    `dev-only id "${id}" must be a real bundled module id`
  )
}

assert.equal(isDevOnlyModule('switchboard'), true)
assert.equal(isDevOnlyModule('voice-dictation'), true)
assert.equal(isDevOnlyModule('roadmap'), true)
assert.equal(isDevOnlyModule('review'), true)
assert.equal(isDevOnlyModule('git'), false)
assert.equal(isDevOnlyModule('agent-runtime'), false)

// activeForChannel over manifests-like records.
const manifests = [
  { id: 'agent-runtime' },
  { id: 'git' },
  { id: 'switchboard' },
  { id: 'multiloop' },
  { id: 'mobile-relay' },
  { id: 'voice-dictation' },
  { id: 'roadmap' },
  { id: 'review' },
]
const getId = (m: { id: string }) => m.id

// Dev channel keeps everything.
assert.deepEqual(
  activeForChannel(manifests, getId, true).map(getId),
  manifests.map(getId),
  'dev channel keeps the full set'
)

// Production channel drops exactly the dev-only ids, preserving order of the rest.
assert.deepEqual(
  activeForChannel(manifests, getId, false).map(getId),
  ['agent-runtime', 'git'],
  'production channel drops the dev-only modules'
)

// activeForChannel returns a fresh array (never the input reference).
assert.notEqual(activeForChannel(manifests, getId, true), manifests)

console.log('dev-only module gate guard passed')
