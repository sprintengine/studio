import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

// A window's contents answer `fromWebContents`; a webview guest's do not.
vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (contents: { inWindow?: boolean } | null) => (contents?.inWindow ? {} : null),
  },
}))

const { assertAppSender, isAppRendererUrl, isAppSender } = await import('./ipc-sender')

const PACKAGED_URL =
  'file:///Applications/SprintEngine%20Studio.app/Contents/Resources/app.asar/out/renderer/index.html'

function event(url: string, options: { parent?: object | null; inWindow?: boolean; frame?: boolean } = {}) {
  return {
    sender: { inWindow: options.inWindow ?? true },
    senderFrame: options.frame === false ? null : { url, parent: options.parent ?? null },
  } as unknown as Parameters<typeof isAppSender>[0]
}

afterEach(() => {
  delete process.env['ELECTRON_RENDERER_URL']
})

test('a packaged app window is the app asking', () => {
  assert.equal(isAppSender(event(`${PACKAGED_URL}?windowId=primary&restoreDetached=0`)), true)
  assert.doesNotThrow(() => assertAppSender(event(PACKAGED_URL)))
})

test('anything that is not the top-level app document is refused', () => {
  // A subframe of the app window: an embedded page, a module's iframe.
  assert.equal(isAppSender(event(PACKAGED_URL, { parent: {} })), false)
  // A webview guest: contents with no window of their own.
  assert.equal(isAppSender(event(PACKAGED_URL, { inWindow: false })), false)
  // A frame that navigated away or was destroyed before the handler ran.
  assert.equal(isAppSender(event(PACKAGED_URL, { frame: false })), false)
  // The canvas worker's page, and the web.
  assert.equal(isAppSender(event(PACKAGED_URL.replace('index.html', 'canvas-worker.html'))), false)
  assert.equal(isAppSender(event('https://example.com/renderer/index.html')), false)
  assert.equal(isAppSender(undefined), false)
  assert.throws(() => assertAppSender(event('https://example.com/')), /did not come from a SprintEngine Studio window/)
})

test('under the dev server only its origin is the app', () => {
  process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173'
  assert.equal(isAppRendererUrl('http://localhost:5173/?windowId=primary'), true)
  assert.equal(isAppRendererUrl('http://localhost:5173/index.html'), true)
  assert.equal(isAppRendererUrl('http://localhost:5173/canvas-worker.html'), false)
  assert.equal(isAppRendererUrl('http://localhost:5174/'), false)
  // A file: page is not the app while a dev server is serving it.
  assert.equal(isAppRendererUrl(PACKAGED_URL), false)
})
