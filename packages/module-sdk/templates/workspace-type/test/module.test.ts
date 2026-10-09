// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeRendererHost } from '@sprintengine/module-sdk/testing'

import manifest from '../module/manifest.json'
import { registerRenderer } from '../src/renderer'

test('creating a workspace stores its goal, and the brief panel shows it', async () => {
  const fake = createFakeRendererHost({ manifest })
  await registerRenderer(fake.host)
  const [type] = fake.registrations.workspaceTypes
  assert.equal(type?.creationStep?.isReady?.({ goal: '  ' }), false, 'a blank goal is not ready')

  await type?.createWorkspace?.(
    { name: '', folderPath: '/Users/dev/projects/app', stepValue: { goal: 'Ship it' }, setStepValue() {} },
    { createWorkspace: () => 'ws-app', removeWorkspace() {} },
  )
  assert.equal((fake.workspaceState('ws-app') as { goal?: string } | undefined)?.goal, 'Ship it')
  assert.match(await fake.render.panel('{{id}}.brief', { workspaceId: 'ws-app' }), /Ship it/)
  assert.deepEqual(fake.undeclared, [])
})

test('a failed write takes the new workspace back', async () => {
  const fake = createFakeRendererHost({ manifest })
  await registerRenderer(fake.host)
  const removed: string[] = []
  // An id the host does not know: its module state cannot be written.
  await assert.rejects(
    fake.registrations.workspaceTypes[0]!.createWorkspace!(
      { name: 'x', folderPath: '/Users/dev/projects/app', stepValue: { goal: 'Ship it' }, setStepValue() {} },
      { createWorkspace: () => 'ws-missing', removeWorkspace: (id) => void removed.push(id) },
    ),
    /not stored/,
  )
  assert.deepEqual(removed, ['ws-missing'])
})
