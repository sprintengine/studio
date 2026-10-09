// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeMainHost } from '@sprintengine/module-sdk/testing'

import manifest from '../module/manifest.json'
import { registerMain } from '../src/main'

const prefix = manifest.id.replace(/-/g, '_')

test('an agent can count words', async () => {
  const fake = createFakeMainHost({ manifest })
  await registerMain(fake.host)
  const result = await fake.tools.call(`${prefix}_word_count`, { text: 'one two\nthree' })
  assert.deepEqual(result.structuredContent, { words: 3, lines: 2, characters: 13 })
  const refused = await fake.tools.call(`${prefix}_word_count`, { text: 42 })
  assert.equal(refused.isError, true)
})

test('an agent can list the open workspaces', async () => {
  const fake = createFakeMainHost({
    manifest,
    workspaces: [{ id: 'ws-docs', name: 'Docs', folderPath: '/Users/dev/docs', mode: 'standard' }],
  })
  await registerMain(fake.host)
  const result = await fake.tools.call(`${prefix}_open_workspaces`)
  assert.equal(result.content[0]?.type === 'text' && result.content[0].text, 'Docs — /Users/dev/docs')
  assert.deepEqual(fake.undeclared, [], 'everything it used is declared in module/manifest.json')
})
