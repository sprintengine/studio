// The main half, against the SDK's fake main host. `npm test` bundles
// test/*.test.ts and runs them with `node --test` (see AGENTS.md).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeMainHost } from '@sprintengine/module-sdk/testing'

import manifest from '../module/manifest.json'
import { registerMain } from '../src/main'

test('the window half can ask when the main half started', async () => {
  const fake = createFakeMainHost({ manifest })
  await registerMain(fake.host)
  const status = (await fake.ipc.invoke('{{id}}:status')) as { startedAt: number }
  assert.equal(typeof status.startedAt, 'number')
  assert.deepEqual(fake.undeclared, [])
})
