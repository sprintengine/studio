// Your tests, in TypeScript. `npm test` bundles test/*.test.ts with esbuild
// (`npm run build:test`, into test/.build) and runs them with `node --test`,
// after `@sprintengine/module-sdk/testing/register` has routed the host's UI
// kit to a stand-in that renders in Node. Import the module's source directly
// and drive it with the SDK's fake hosts.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeRendererHost } from '@sprintengine/module-sdk/testing'

import manifest from '../module/manifest.json'
import { registerRenderer } from '../src/renderer'

test('the command says hello with the host API version', async () => {
  const fake = createFakeRendererHost({ manifest })
  await registerRenderer(fake.host)
  assert.deepEqual(
    fake.registrations.commands.map((command) => command.id),
    ['say-hello'],
  )

  // The command runs in a window; give it one that records what it shows.
  const shown: string[] = []
  Object.assign(globalThis, { window: { alert: (message: string) => shown.push(message) } })
  await fake.runCommand('say-hello')
  assert.deepEqual(shown, ['{{displayName}} is running on host API 1.'])
  assert.deepEqual(fake.undeclared, [], 'everything it used is declared in module/manifest.json')
})
