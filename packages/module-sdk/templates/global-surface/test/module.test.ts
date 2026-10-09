// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeRendererHost } from '@sprintengine/module-sdk/testing'

import manifest from '../module/manifest.json'
import { registerRenderer } from '../src/renderer'

test('the door renders inside the shell, waiting for the workspaces', async () => {
  const fake = createFakeRendererHost({ manifest })
  await registerRenderer(fake.host)
  // A server render runs no effects, so the door is drawn before the
  // workspace list arrives: its loading state.
  const html = await fake.render.surface('{{id}}')
  assert.match(html, /data-kit="GlobalSurfaceShell"/)
  assert.match(html, /Reading workspaces/)
  assert.equal(fake.host.openGlobalSurface('{{id}}'), true)
  assert.deepEqual(fake.undeclared, [])
})
