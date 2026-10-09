// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeRendererHost } from '@sprintengine/module-sdk/testing'

import manifest from '../module/manifest.json'
import { registerRenderer } from '../src/renderer'
import { greetingFrom } from '../src/SettingsSection'

test('the greeting follows the saved name and tone', () => {
  assert.equal(greetingFrom({}), 'Hello, there.')
  assert.equal(greetingFrom({ name: ' Ada ', tone: 'warm' }), 'Good to see you, Ada!')
})

test('the section previews what was saved, and the command copies it', async () => {
  const fake = createFakeRendererHost({ manifest, appState: { name: 'Ada' } })
  await registerRenderer(fake.host)
  assert.match(await fake.render.settings('{{id}}'), /Preview: Hello, Ada\./)

  const copied: string[] = []
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
    configurable: true,
  })
  await fake.runCommand('copy-greeting')
  assert.deepEqual(copied, ['Hello, Ada.'])
  assert.deepEqual(fake.undeclared, [])
})
