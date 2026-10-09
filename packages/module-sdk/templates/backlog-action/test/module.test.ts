// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BacklogItemActionContext, BacklogItemView } from '@sprintengine/module-sdk'
import { createFakeRendererHost } from '@sprintengine/module-sdk/testing'

import manifest from '../module/manifest.json'
import { registerRenderer } from '../src/renderer'

function contextFor(item: Partial<BacklogItemView>): BacklogItemActionContext {
  return {
    workspaceId: 'ws-app',
    item: { title: 'Ship the importer', relativePath: 'backlog/ship-the-importer.md', status: 'ready', ...item },
  } as BacklogItemActionContext
}

test('a closed item cannot be planned', async () => {
  const fake = createFakeRendererHost({ manifest })
  await registerRenderer(fake.host)
  const [action] = fake.registrations.backlogItemActions
  assert.equal(action?.getState?.(contextFor({ status: 'completed' })), 'disabled')
  assert.equal(action?.getState?.(contextFor({ status: 'ready' })), 'enabled')
})

test('planning opens a draft chat that names the item', async () => {
  const fake = createFakeRendererHost({ manifest })
  await registerRenderer(fake.host)
  await fake.registrations.backlogItemActions[0]?.run(contextFor({}))
  assert.equal(fake.openedChats.length, 1)
  assert.match(fake.openedChats[0]?.prompt ?? '', /"Ship the importer" \(backlog\/ship-the-importer\.md\)/)
  assert.notEqual(fake.openedChats[0]?.send, true, 'a draft: the person sends it')
  assert.deepEqual(fake.undeclared, [])
})
