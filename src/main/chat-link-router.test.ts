import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createChatLinkRouter, type ChatLinkWindow } from './chat-link-router'
import type { ChatLink } from '../shared/deep-link'

type FakeWindow = ChatLinkWindow & {
  id: string
  focused: boolean
  visible: boolean
  minimized: boolean
  destroyed: boolean
  raised: string[]
}

function fakeWindow(id: string, options: Partial<Pick<FakeWindow, 'focused' | 'visible' | 'minimized'>> = {}) {
  const win: FakeWindow = {
    id,
    focused: options.focused ?? false,
    visible: options.visible ?? true,
    minimized: options.minimized ?? false,
    destroyed: false,
    raised: [],
    isDestroyed: () => win.destroyed,
    isFocused: () => win.focused,
    isVisible: () => win.visible,
    isMinimized: () => win.minimized,
    restore: () => void win.raised.push('restore'),
    focus: () => void win.raised.push('focus'),
  }
  return win
}

function harness(options: { windows?: FakeWindow[]; holders?: Record<string, string>; appReady?: boolean } = {}) {
  const windows = options.windows ?? []
  const sent: { to: string; link: ChatLink }[] = []
  const generations: number[] = []
  let appReady = options.appReady ?? true
  let windowsOpened = 0
  const router = createChatLinkRouter<FakeWindow>({
    windows: () => windows,
    windowIdOf: (win) => win.id,
    primaryWindowId: () => 'primary',
    holderOf: (chatId) => options.holders?.[chatId] ?? null,
    canOpenWindow: () => appReady,
    openWindow: () => void (windowsOpened += 1),
    send: (win, link, generation) => {
      sent.push({ to: win.id, link })
      generations.push(generation)
    },
  })
  return {
    router,
    windows,
    sent,
    windowsOpened: () => windowsOpened,
    setAppReady: (ready: boolean) => void (appReady = ready),
    /** The generation of the last link sent, as the window's renderer would acknowledge it. */
    lastGeneration: () => {
      const generation = generations.at(-1)
      assert.ok(generation !== undefined, 'a link was sent')
      return generation
    },
  }
}

const link = (chatId: string, agentId: string | null = null): ChatLink => ({ kind: 'chat', chatId, agentId })

test('a link opens in the window that holds its chat, even when another is focused', () => {
  const primary = fakeWindow('primary', { focused: true })
  const detached = fakeWindow('detached-a')
  const h = harness({ windows: [primary, detached], holders: { ws1: 'detached-a' } })
  h.router.windowReady(primary)
  h.router.windowReady(detached)
  h.router.open(link('ws1', 'a1'))
  assert.deepEqual(h.sent, [{ to: 'detached-a', link: link('ws1', 'a1') }])
  assert.deepEqual(detached.raised, ['focus'])
  assert.deepEqual(primary.raised, [])
})

test('a chat no window holds goes to the focused window, which says it is not here', () => {
  const primary = fakeWindow('primary')
  const detached = fakeWindow('detached-a', { focused: true })
  const h = harness({ windows: [primary, detached] })
  h.router.windowReady(primary)
  h.router.windowReady(detached)
  h.router.open(link('ws-missing'))
  assert.deepEqual(h.sent, [{ to: 'detached-a', link: link('ws-missing') }])
})

test('with no window focused the primary takes it, and a minimized one is restored', () => {
  const detached = fakeWindow('detached-a')
  const primary = fakeWindow('primary', { minimized: true })
  const h = harness({ windows: [detached, primary] })
  h.router.windowReady(detached)
  h.router.windowReady(primary)
  h.router.open(link('ws-missing'))
  assert.deepEqual(h.sent, [{ to: 'primary', link: link('ws-missing') }])
  assert.deepEqual(primary.raised, ['restore', 'focus'])
})

test('a link that arrives before ready waits for the first window to listen (macOS cold start)', () => {
  const h = harness({ appReady: false })
  h.router.open(link('ws1'))
  assert.equal(h.windowsOpened(), 0, 'the boot makes the first window, not the link')
  assert.deepEqual(h.sent, [])

  // `ready`: the boot creates the primary, held hidden behind the splash.
  h.setAppReady(true)
  const primary = fakeWindow('primary', { visible: false })
  h.windows.push(primary)
  h.router.windowGone(primary)
  assert.deepEqual(h.sent, [], 'a window that is still loading is not handed the link')
  assert.equal(h.windowsOpened(), 0)

  h.router.windowReady(primary)
  assert.deepEqual(h.sent, [{ to: 'primary', link: link('ws1') }])
  assert.deepEqual(primary.raised, [], 'the boot reveal shows it, never the link')
})

test('only the latest link is held, and once opened it is not sent again', () => {
  const primary = fakeWindow('primary')
  const h = harness({ windows: [primary] })
  h.router.open(link('ws1'))
  h.router.open(link('ws2'))
  h.router.windowReady(primary)
  h.router.ack(primary, h.lastGeneration())
  h.router.windowReady(primary)
  assert.deepEqual(h.sent, [{ to: 'primary', link: link('ws2') }])
})

test('with the app in the background a window is opened once, and the link waits for it', () => {
  const h = harness()
  h.router.open(link('ws1'))
  assert.equal(h.windowsOpened(), 1)
  const stray = fakeWindow('detached-a')
  h.router.windowGone(stray)
  assert.equal(h.windowsOpened(), 1, 'a later flush does not open a second window')

  const primary = fakeWindow('primary')
  h.windows.push(primary)
  h.router.windowReady(primary)
  assert.deepEqual(h.sent, [{ to: 'primary', link: link('ws1') }])
})

test('the holding window reloading holds the link until its new page listens', () => {
  const primary = fakeWindow('primary', { focused: true })
  const detached = fakeWindow('detached-a')
  const h = harness({ windows: [primary, detached], holders: { ws1: 'detached-a' } })
  h.router.windowReady(primary)
  h.router.windowReady(detached)
  h.router.windowGone(detached)
  h.router.open(link('ws1'))
  assert.deepEqual(h.sent, [])
  h.router.windowReady(detached)
  assert.deepEqual(h.sent, [{ to: 'detached-a', link: link('ws1') }])
})

test('a holding window that closes hands the link to the next choice', () => {
  const primary = fakeWindow('primary')
  const detached = fakeWindow('detached-a')
  const h = harness({ windows: [primary, detached], holders: { ws1: 'detached-a' } })
  h.router.windowReady(primary)
  h.router.open(link('ws1'))
  assert.deepEqual(h.sent, [])
  detached.destroyed = true
  h.router.windowGone(detached)
  assert.deepEqual(h.sent, [{ to: 'primary', link: link('ws1') }])
})

test('a link the window never acknowledged is sent again when its reloaded page listens', () => {
  const primary = fakeWindow('primary')
  const h = harness({ windows: [primary] })
  h.router.windowReady(primary)
  h.router.open(link('ws1'))
  const first = h.lastGeneration()
  // The renderer crashed or reloaded before it opened the chat.
  h.router.windowGone(primary)
  assert.equal(h.sent.length, 1, 'nothing goes to a window that is not listening')
  h.router.windowReady(primary)
  assert.deepEqual(h.sent, [
    { to: 'primary', link: link('ws1') },
    { to: 'primary', link: link('ws1') },
  ])
  assert.equal(h.lastGeneration(), first, 'the same link, so a page that did see it can drop it')
})

test('a window that says it is listening again without going is sent the unacknowledged link again', () => {
  const primary = fakeWindow('primary')
  const h = harness({ windows: [primary] })
  h.router.windowReady(primary)
  h.router.open(link('ws1'))
  h.router.windowReady(primary)
  assert.equal(h.sent.length, 2)
})

test('an acknowledged link is not sent again when the window reloads', () => {
  const primary = fakeWindow('primary')
  const h = harness({ windows: [primary] })
  h.router.windowReady(primary)
  h.router.open(link('ws1'))
  h.router.ack(primary, h.lastGeneration())
  h.router.windowGone(primary)
  h.router.windowReady(primary)
  assert.deepEqual(h.sent, [{ to: 'primary', link: link('ws1') }])
})

test('a window closed before it acknowledged the link hands it to another window', () => {
  const primary = fakeWindow('primary')
  const detached = fakeWindow('detached-a')
  const h = harness({ windows: [primary, detached], holders: { ws1: 'detached-a' } })
  h.router.windowReady(primary)
  h.router.windowReady(detached)
  h.router.open(link('ws1'))
  assert.deepEqual(h.sent, [{ to: 'detached-a', link: link('ws1') }])
  detached.destroyed = true
  h.router.windowGone(detached)
  assert.deepEqual(h.sent, [
    { to: 'detached-a', link: link('ws1') },
    { to: 'primary', link: link('ws1') },
  ])
  assert.deepEqual(primary.raised, ['focus'], 'the window that takes it over comes forward')
})

test('a newer link replaces one still waiting to be acknowledged', () => {
  const primary = fakeWindow('primary')
  const h = harness({ windows: [primary] })
  h.router.windowReady(primary)
  h.router.open(link('ws1'))
  const older = h.lastGeneration()
  h.router.open(link('ws2'))
  const newer = h.lastGeneration()
  assert.notEqual(newer, older)
  h.router.ack(primary, older)
  // The window reloads before it opened the newer one: only that one goes again.
  h.router.windowGone(primary)
  h.router.windowReady(primary)
  assert.deepEqual(
    h.sent.map((entry) => entry.link.chatId),
    ['ws1', 'ws2', 'ws2'],
  )
})

test('an acknowledgement of a stale generation, or from another window, is ignored', () => {
  const primary = fakeWindow('primary')
  const detached = fakeWindow('detached-a')
  const h = harness({ windows: [primary, detached] })
  h.router.windowReady(primary)
  h.router.windowReady(detached)
  h.router.open(link('ws1'))
  const generation = h.lastGeneration()
  h.router.ack(primary, generation - 1)
  h.router.ack(detached, generation)
  h.router.windowGone(primary)
  h.router.windowReady(primary)
  assert.equal(h.sent.length, 2, 'still unacknowledged, so sent again')
  h.router.ack(primary, generation)
  h.router.windowGone(primary)
  h.router.windowReady(primary)
  assert.equal(h.sent.length, 2)
})
