// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeRendererHost } from '@sprintengine/module-sdk/testing'

import manifest from '../module/manifest.json'
import { registerRenderer } from '../src/renderer'

test('the timer offers to start, then counts down what is saved', async () => {
  const idle = createFakeRendererHost({ manifest })
  await registerRenderer(idle.host)
  assert.match(await idle.render.topBar('{{id}}.timer'), /Focus/)

  const running = createFakeRendererHost({ manifest, appState: { focusEndsAt: Date.now() + 5 * 60_000 } })
  await registerRenderer(running.host)
  assert.match(await running.render.topBar('{{id}}.timer'), /[45]:\d\d/)
  assert.deepEqual(running.undeclared, [])
})
