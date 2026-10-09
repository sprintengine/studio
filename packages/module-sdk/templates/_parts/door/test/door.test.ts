// The door, rendered against the SDK's fake renderer host and the
// pass-through kit. `npm test` bundles test/*.test.ts and runs them with
// `node --test`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeRendererHost } from '@sprintengine/module-sdk/testing'

import manifest from '../module/manifest.json'
import { registerRenderer } from '../src/renderer'

test('the door renders in the host’s shell', async () => {
  const fake = createFakeRendererHost({ manifest })
  await registerRenderer(fake.host)
  const html = await fake.render.surface('{{id}}-door')
  assert.match(html, /data-kit="GlobalSurfaceShell"/)
  assert.match(html, /Nothing here yet/)
})
