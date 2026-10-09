// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeRendererHost } from '@sprintengine/module-sdk/testing'

import manifest from '../module/manifest.json'
import { registerRenderer } from '../src/renderer'

test('the panel shows the notes saved last time', async () => {
  const fake = createFakeRendererHost({ manifest, appState: { notes: 'Buy more coffee' } })
  await registerRenderer(fake.host)
  const html = await fake.render.panel('{{id}}.notes')
  assert.match(html, /Buy more coffee/)
  assert.match(html, /Saved/)
})

test('the command opens the notes workspace', async () => {
  const fake = createFakeRendererHost({ manifest })
  await registerRenderer(fake.host)
  await fake.runCommand('open')
  assert.deepEqual(fake.openedSurfaces, [{ kind: 'workspace', id: '{{id}}' }])
  assert.deepEqual(fake.undeclared, [])
})
