// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes:
// the main half against a fake host whose chats you can make the agent answer
// in, the window half against a fake renderer bridged to it.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeMainHost, createFakeRendererHost } from '@sprintengine/module-sdk/testing'

import manifest from '../module/manifest.json'
import { registerMain } from '../src/main'
import { CHANNELS } from '../src/protocol'
import { registerRenderer } from '../src/renderer'

test('starting a summary opens a chat, and its end is announced', async () => {
  const main = createFakeMainHost({ manifest })
  await registerMain(main.host)
  await main.startup()

  const started = (await main.ipc.invoke(CHANNELS.start, { workspaceId: 'ws-app' })) as {
    ok: boolean
    conversation?: { workspaceId: string; agentId: string }
  }
  assert.ok(started.ok && started.conversation)
  const [chat] = main.services.conversations.all()
  assert.match(String(chat?.events.find((event) => event.type === 'user_message')?.payload?.text), /README/)

  // The agent finishes its turn.
  main.services.conversations.emitEvent(started.conversation, { type: 'turn_completed' })
  assert.deepEqual(
    main.notifications.map((notification) => notification.title),
    ['Project summary is ready'],
  )
  assert.ok(main.emitted.some((event) => event.topic === 'conversations-changed'), 'windows are told to read again')
  assert.deepEqual(main.undeclared, [])
})

test('a bad request is answered, not thrown', async () => {
  const main = createFakeMainHost({ manifest })
  await registerMain(main.host)
  assert.deepEqual(await main.ipc.invoke(CHANNELS.start, {}), {
    ok: false,
    code: 'invalid_input',
    message: 'Pick a workspace first.',
  })
})

test('the door renders, and reaches the main half over the bridge', async () => {
  const main = createFakeMainHost({ manifest })
  await registerMain(main.host)
  const renderer = createFakeRendererHost({ main })
  await registerRenderer(renderer.host)
  assert.match(await renderer.render.surface('{{id}}'), /None yet/)
  assert.deepEqual(await renderer.host.invoke(CHANNELS.list), [])
  assert.deepEqual(renderer.undeclared, [])
})
