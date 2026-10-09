// The Settings section, rendered against the SDK's fake renderer host.
// `npm test` bundles test/*.test.ts and runs them with `node --test`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeRendererHost } from '@sprintengine/module-sdk/testing'

import manifest from '../module/manifest.json'
import { registerRenderer } from '../src/renderer'

test('the section shows what was saved', async () => {
  const fake = createFakeRendererHost({ manifest, appState: { label: 'Night shift' } })
  await registerRenderer(fake.host)
  assert.match(await fake.render.settings('{{id}}-settings'), /Night shift/)
  assert.deepEqual(fake.undeclared, [])
})
