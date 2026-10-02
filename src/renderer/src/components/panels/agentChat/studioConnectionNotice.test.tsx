import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { installStudioLoopback, type StudioLoopback } from '../../../../../../tests/studio-chat-loopback'

// A chat on the Studio protocol says, in words, that its window's connection
// is being made again, and only once the drop has outlasted a blip; it says
// nothing once the connection is back, and nothing at all on the IPC.

beforeEach(() => vi.stubEnv('STUDIO_CHAT_TRANSPORT_UNDER_TEST', 'studio'))
afterEach(() => vi.unstubAllEnvs())

// Each step is its own `act`, so React draws what changed before the next look.
const until = async (check: () => boolean, what: string) => {
  const { act } = await import('react')
  for (let tries = 0; !check() && tries < 400; tries++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

type Connect = () => Promise<{ connectionId: string; ticket: string }>

test('a dropped connection is told in words after a moment, and the words go once it is back', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.assign(dom.window, { api: {} })
  const win = dom.window as unknown as { api: Record<string, unknown> }
  const loopback = installStudioLoopback(win) as StudioLoopback
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { StudioConnectionNotice } = await import('./studioConnectionNotice')
  const { windowStudioClient } = await import('../../../studio/windowStudioClient')
  const host = document.createElement('div')
  const root = createRoot(host)
  const client = await windowStudioClient(win.api as never)
  const parkedWords = 'This window lost its connection to Studio. It tries again the next time you use the chat.'
  try {
    await act(async () => root.render(createElement(StudioConnectionNotice, { graceMs: 150 })))
    expect(host.textContent).toBe('')

    // Studio stops answering: after the grace, the chat says it is reconnecting.
    const connect = win.api.studioConnect as Connect
    win.api.studioConnect = async () => {
      throw new Error('Studio did not hand this window its connection.')
    }
    await act(async () => loopback.drop())
    expect(host.textContent, 'a blip says nothing').toBe('')
    await until(() => host.textContent !== '', 'the reconnecting row')
    expect(host.textContent).toBe('Reconnecting to Studio… The chat picks up where it left off.')
    expect(host.querySelector('[role="status"]')).not.toBeNull()

    // Back: the row goes.
    win.api.studioConnect = connect
    await until(() => host.textContent === '', 'the row to go')

    // A ticket Studio refuses parks the window until it is next used, and says so.
    win.api.studioConnect = async () => ({ ...(await connect()), ticket: 'seport_not_the_ticket_000000' })
    await act(async () => loopback.drop())
    // It reconnects with the refused ticket first, then parks.
    await until(() => host.textContent === parkedWords, 'the parked row')
  } finally {
    // Nothing of this window is left to wake or draw once the test is done.
    await act(async () => root.unmount())
    client.close()
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('a window on the conversation IPC never draws it', async () => {
  vi.unstubAllEnvs()
  const { studioConnectionWords } = await import('./studioConnectionNotice')
  expect(studioConnectionWords(null)).toBeNull()
  expect(studioConnectionWords('open')).toBeNull()
  expect(studioConnectionWords('connecting')).toBeNull()
})

test('a window that could not reach Studio says when it tries again, not that it is reconnecting', async () => {
  const { studioConnectionWords } = await import('./studioConnectionNotice')
  expect(studioConnectionWords('unavailable')).toBe(
    'This window could not reach Studio. It tries again the next time you use the chat.',
  )
})
