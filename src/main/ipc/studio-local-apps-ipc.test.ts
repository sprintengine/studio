import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'
import { test, vi } from 'vitest'

// A window's contents answer `fromWebContents`; a webview guest's do not.
vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (contents: { inWindow?: boolean } | null) => (contents?.inWindow ? {} : null),
  },
}))

const { registerStudioLocalAppsIpc } = await import('./studio-local-apps-ipc')
const { assertAppSender } = await import('./ipc-sender')
const { STUDIO_LOCAL_APPS_OFFER_CHANNEL, STUDIO_LOCAL_APPS_REVOKE_CHANNEL, STUDIO_LOCAL_APPS_STATUS_CHANNEL } =
  await import('../../shared/studio-local-apps')

const APP_URL = 'file:///Applications/SprintEngine%20Studio.app/Contents/Resources/app.asar/out/renderer/index.html'

type Sender = { url: string; parent?: object | null; inWindow?: boolean }

function harness() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const calls: string[] = []
  const status = { running: true, socketPath: null, lastError: null, apps: [], offers: [] }
  registerStudioLocalAppsIpc(
    { handle: (channel: string, handler: never) => handlers.set(channel, handler) } as unknown as IpcMain,
    {
      getStatus: () => status,
      offer: () => {
        calls.push('offer')
        return { code: 'sepair_x', offer: {}, status }
      },
      cancelOffer: () => status,
      revoke: () => {
        calls.push('revoke')
        return status
      },
    } as never,
    assertAppSender,
  )
  const invoke = (channel: string, sender: Sender, ...args: unknown[]) =>
    handlers.get(channel)!(
      {
        sender: { inWindow: sender.inWindow ?? true },
        senderFrame: { url: sender.url, parent: sender.parent ?? null },
      },
      ...args,
    )
  return { invoke, calls }
}

test('only the app’s own window may mint a pairing code, revoke an app or read the list', () => {
  const { invoke, calls } = harness()
  const offer = { name: 'x', scopes: ['conversation:operate'], ceiling: 'bypass' }
  // A module's iframe inside the app window, a webview guest, a window gone elsewhere.
  const strangers: Sender[] = [
    { url: APP_URL, parent: {} },
    { url: APP_URL, inWindow: false },
    { url: 'https://example.com/' },
  ]
  for (const sender of strangers) {
    assert.throws(
      () => invoke(STUDIO_LOCAL_APPS_OFFER_CHANNEL, sender, offer),
      /did not come from a SprintEngine Studio window/,
    )
    assert.throws(() => invoke(STUDIO_LOCAL_APPS_REVOKE_CHANNEL, sender, 'sla_1'), /did not come from/)
    assert.throws(() => invoke(STUDIO_LOCAL_APPS_STATUS_CHANNEL, sender), /did not come from/)
  }
  assert.deepEqual(calls, [])
  invoke(STUDIO_LOCAL_APPS_OFFER_CHANNEL, { url: APP_URL }, offer)
  invoke(STUDIO_LOCAL_APPS_REVOKE_CHANNEL, { url: APP_URL }, 'sla_1')
  assert.deepEqual(calls, ['offer', 'revoke'])
})
