import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { test, vi } from 'vitest'

import type { IpcMain } from 'electron'
import type { SkillsService } from '../skills'

vi.mock('electron', () => import('../../../tests/stubs/electron'))

const { webContents } = await import('../../../tests/stubs/electron')
const { registerSkillsIpc } = await import('./skills-ipc')

type Handler = (event: unknown, input: unknown) => Promise<unknown>

function registered() {
  const handlers = new Map<string, Handler>()
  const calls: string[] = []
  const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }
  // Every service method answers its own name, so a test sees what was reached.
  const service = new Proxy(
    {},
    {
      get: (_target, method: string) => async () => {
        calls.push(method)
        return { ok: true }
      },
    },
  ) as SkillsService
  registerSkillsIpc(ipcMain as unknown as IpcMain, service)
  return { handlers, calls }
}

delete process.env['ELECTRON_RENDERER_URL']
// The app's own window: its top-level document is the renderer's index.html.
const appEvent = {
  sender: webContents,
  senderFrame: { parent: null, url: pathToFileURL('/Applications/Studio.app/out/renderer/index.html').href },
}
// An embedded page inside that window, and a top-level page somewhere else.
const subframeEvent = { ...appEvent, senderFrame: { ...appEvent.senderFrame, parent: {} } }
const foreignEvent = { ...appEvent, senderFrame: { parent: null, url: 'https://example.com/' } }

const MUTATING = [
  'skills:add-source',
  'skills:add-local-source',
  'skills:remove-source',
  'skills:install',
  'skills:uninstall',
  'skills:sync-source',
  'skills:install-plugin',
  'skills:uninstall-plugin',
]

test('what changes the installed skills answers only the app’s own window', async () => {
  const { handlers, calls } = registered()
  for (const channel of MUTATING) {
    const handler = handlers.get(channel)
    assert.ok(handler, channel)
    for (const event of [subframeEvent, foreignEvent, null]) {
      await assert.rejects(async () => handler(event, {}), /did not come from a SprintEngine Studio window/, channel)
    }
    assert.deepEqual(calls, [], `${channel} reached the service for a foreign sender`)
    assert.deepEqual(await handler(appEvent, {}), { ok: true }, channel)
    calls.length = 0
  }
})

test('what only reads still answers', async () => {
  const { handlers, calls } = registered()
  await handlers.get('skills:list-sources')!(foreignEvent, undefined)
  await handlers.get('skills:search')!(foreignEvent, {})
  assert.deepEqual(calls, ['listSources', 'search'])
})
