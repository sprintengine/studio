// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { FileActionContext } from '@sprintengine/module-sdk'
import { createFakeRendererHost } from '@sprintengine/module-sdk/testing'

import manifest from '../module/manifest.json'
import { registerRenderer } from '../src/renderer'

test('copies each selected path relative to the project', async () => {
  const fake = createFakeRendererHost({ manifest })
  await registerRenderer(fake.host)
  const [action] = fake.registrations.fileActions
  const context: FileActionContext = {
    workspaceId: 'ws-app',
    workspaceRoot: '/Users/dev/projects/app',
    entries: [
      { name: 'index.ts', path: '/Users/dev/projects/app/src/index.ts', isDir: false },
      { name: 'docs', path: '/Users/dev/projects/app/docs', isDir: true },
    ],
  }
  assert.equal(action?.getLabel?.(context), 'Copy 2 relative paths')

  const copied: string[] = []
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
    configurable: true,
  })
  await action?.run(context)
  assert.deepEqual(copied, ['src/index.ts\ndocs'])
})
