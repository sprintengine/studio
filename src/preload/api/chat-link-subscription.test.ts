import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'vitest'

import { subscribeToChatLinks } from './chat-link-subscription'
import {
  CHAT_LINK_ACK_CHANNEL,
  CHAT_LINK_OPEN_CHANNEL,
  CHAT_LINK_READY_CHANNEL,
  CHAT_LINK_UNREADY_CHANNEL,
  type ChatLink,
} from '../../shared/deep-link'

// A stand-in for the window's `ipcRenderer`: what the page sends to main is
// recorded, and `deliver` is main sending a link to the page.
function fakeIpc() {
  const page = new EventEmitter()
  const toMain: unknown[][] = []
  return {
    ipc: {
      on: (channel: string, listener: (...args: unknown[]) => void) => page.on(channel, listener),
      removeListener: (channel: string, listener: (...args: unknown[]) => void) =>
        page.removeListener(channel, listener),
      send: (channel: string, ...args: unknown[]) => void toMain.push([channel, ...args]),
    },
    toMain,
    deliver: (link: ChatLink, generation: unknown) => void page.emit(CHAT_LINK_OPEN_CHANNEL, {}, link, generation),
    listeners: () => page.listenerCount(CHAT_LINK_OPEN_CHANNEL),
  }
}

const link = (chatId: string): ChatLink => ({ kind: 'chat', chatId, agentId: null })

test('subscribing listens first and then tells main, and unsubscribing undoes both', () => {
  const fake = fakeIpc()
  let listeningWhenReadySent = -1
  const ipc = {
    ...fake.ipc,
    send: (channel: string, ...args: unknown[]) => {
      if (channel === CHAT_LINK_READY_CHANNEL) listeningWhenReadySent = fake.listeners()
      fake.ipc.send(channel, ...args)
    },
  }
  const unsubscribe = subscribeToChatLinks(ipc, () => undefined)
  assert.equal(listeningWhenReadySent, 1)
  unsubscribe()
  assert.equal(fake.listeners(), 0)
  assert.deepEqual(fake.toMain, [[CHAT_LINK_READY_CHANNEL], [CHAT_LINK_UNREADY_CHANNEL]])
})

test('a link is opened and then acknowledged with its generation', () => {
  const fake = fakeIpc()
  const order: string[] = []
  subscribeToChatLinks(
    {
      ...fake.ipc,
      send: (channel, ...args) => {
        order.push(`send ${channel} ${args.join(' ')}`.trim())
        fake.ipc.send(channel, ...args)
      },
    },
    (opened) => void order.push(`open ${opened.chatId}`),
  )
  fake.deliver(link('ws1'), 4)
  assert.deepEqual(order, [`send ${CHAT_LINK_READY_CHANNEL}`, 'open ws1', `send ${CHAT_LINK_ACK_CHANNEL} 4`])
})

test('a generation already opened is not opened twice when main sends it again', () => {
  const fake = fakeIpc()
  const opened: string[] = []
  subscribeToChatLinks(fake.ipc, (one) => void opened.push(one.chatId))
  fake.deliver(link('ws1'), 1)
  fake.deliver(link('ws1'), 1)
  fake.deliver(link('ws2'), 2)
  assert.deepEqual(opened, ['ws1', 'ws2'])
  assert.deepEqual(
    fake.toMain.filter(([channel]) => channel === CHAT_LINK_ACK_CHANNEL),
    [
      [CHAT_LINK_ACK_CHANNEL, 1],
      [CHAT_LINK_ACK_CHANNEL, 2],
    ],
  )
})

test('a callback that throws leaves the link unacknowledged, and a resend tries again', () => {
  const fake = fakeIpc()
  let attempts = 0
  subscribeToChatLinks(fake.ipc, () => {
    attempts += 1
    if (attempts === 1) throw new Error('store not ready')
  })
  assert.throws(() => fake.deliver(link('ws1'), 3), /store not ready/)
  assert.ok(!fake.toMain.some(([channel]) => channel === CHAT_LINK_ACK_CHANNEL))
  fake.deliver(link('ws1'), 3)
  assert.equal(attempts, 2)
  assert.deepEqual(fake.toMain.at(-1), [CHAT_LINK_ACK_CHANNEL, 3])
})

test('a message without a generation is not opened', () => {
  const fake = fakeIpc()
  const opened: string[] = []
  subscribeToChatLinks(fake.ipc, (one) => void opened.push(one.chatId))
  fake.deliver(link('ws1'), undefined)
  assert.deepEqual(opened, [])
})

test('each subscription keeps its own record of what it opened', () => {
  const fake = fakeIpc()
  const opened: string[] = []
  const first = subscribeToChatLinks(fake.ipc, (one) => void opened.push(`first ${one.chatId}`))
  fake.deliver(link('ws1'), 1)
  first()
  subscribeToChatLinks(fake.ipc, (one) => void opened.push(`second ${one.chatId}`))
  fake.deliver(link('ws1'), 1)
  assert.deepEqual(opened, ['first ws1', 'second ws1'])
})
