import assert from 'node:assert/strict'

import { BUNDLED_MODULE_IDS } from './manifest'
import { DEV_ONLY_MODULE_IDS, isDevOnlyModule, activeForChannel } from './dev-only'
import { test } from 'vitest'

test('dev-only', async () => {
  // The dev-only ids are the surfaces gated out of production builds. None
  // today: voice dictation, the last one, was retired and its id is only
  // reserved now.
  assert.deepEqual([...DEV_ONLY_MODULE_IDS].sort(), [], 'dev-only ids must be exactly the gated surfaces')

  // Every dev-only id must be a real bundled module id — a typo here would
  // silently gate nothing.
  for (const id of DEV_ONLY_MODULE_IDS) {
    assert.ok(BUNDLED_MODULE_IDS.includes(id), `dev-only id "${id}" must be a real bundled module id`)
  }

  // A retired id is reserved, not dev-only: no build carries it at all.
  assert.equal(isDevOnlyModule('voice-dictation'), false)
  assert.equal(isDevOnlyModule('git'), false)
  assert.equal(isDevOnlyModule('agent-runtime'), false)

  // activeForChannel over manifests-like records, with every dev-only id mixed
  // in after the always-on ones.
  const manifests = [{ id: 'agent-runtime' }, { id: 'git' }, ...DEV_ONLY_MODULE_IDS.map((id) => ({ id }))]
  const getId = (m: { id: string }) => m.id

  // Dev channel keeps everything.
  assert.deepEqual(
    activeForChannel(manifests, getId, true).map(getId),
    manifests.map(getId),
    'dev channel keeps the full set',
  )

  // Production channel drops exactly the dev-only ids, preserving order of the rest.
  assert.deepEqual(
    activeForChannel(manifests, getId, false).map(getId),
    ['agent-runtime', 'git'],
    'production channel drops the dev-only modules',
  )

  // activeForChannel returns a fresh array (never the input reference).
  assert.notEqual(activeForChannel(manifests, getId, true), manifests)
  assert.notEqual(activeForChannel(manifests, getId, false), manifests)

  console.log('dev-only module gate guard passed')
})
