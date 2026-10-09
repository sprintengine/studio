import assert from 'node:assert/strict'

import type { IpcMainInvokeEvent } from 'electron'
import { test } from 'vitest'

import type { QuitDecision } from '../quit-confirmation'
import { APP_RESTART_CHANNEL, registerAppRestartIpc } from './app-restart-ipc'

function harness(decision: QuitDecision, refuseSender = false) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => Promise<unknown>>()
  let relaunched = 0
  let asked = 0
  registerAppRestartIpc(
    { handle: (channel, handler) => void handlers.set(channel, handler as never) },
    {
      confirm: async () => {
        asked += 1
        return decision
      },
      relaunch: () => {
        relaunched += 1
      },
      assertSender: () => {
        if (refuseSender) throw new Error('not the app')
      },
    },
  )
  const invoke = () => handlers.get(APP_RESTART_CHANNEL)!({} as IpcMainInvokeEvent)
  return { invoke, relaunched: () => relaunched, asked: () => asked }
}

test('a restart asks the quit question first and relaunches only on Quit', async () => {
  const quit = harness('quit')
  assert.deepEqual(await quit.invoke(), { restarting: true })
  assert.equal(quit.asked(), 1)
  assert.equal(quit.relaunched(), 1)
})

test('Cancel on the quit question leaves the app running and nothing armed', async () => {
  const stay = harness('stay')
  assert.deepEqual(await stay.invoke(), { restarting: false })
  assert.equal(stay.relaunched(), 0)
})

test('a question already up for an earlier quit decides; this request does nothing', async () => {
  const pending = harness('pending')
  assert.deepEqual(await pending.invoke(), { restarting: false })
  assert.equal(pending.relaunched(), 0)
})

test('only the app window may restart the app', async () => {
  const foreign = harness('quit', true)
  await assert.rejects(foreign.invoke(), /not the app/)
  assert.equal(foreign.asked(), 0)
  assert.equal(foreign.relaunched(), 0)
})
