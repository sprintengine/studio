// The MCP tools, called the way an agent calls them, against the SDK's fake
// main host. `npm test` bundles test/*.test.ts and runs them with `node --test`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeMainHost } from '@sprintengine/module-sdk/testing'

import manifest from '../module/manifest.json'
import { registerMain } from '../src/main'

test('an agent can ask which extension this is', async () => {
  const fake = createFakeMainHost({ manifest })
  await registerMain(fake.host)
  const result = await fake.tools.call(`${manifest.id.replace(/-/g, '_')}_about`)
  assert.deepEqual(result.structuredContent, { moduleId: manifest.id, hostApiVersion: 1 })
})
