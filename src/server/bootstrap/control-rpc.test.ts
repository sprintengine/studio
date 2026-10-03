import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

import { ControlRpcError, createControlRpc, type ControlRpc, type ControlRpcFrame } from './control-rpc'

/** Two ends wired to each other, delivering on the next turn as a real channel does. */
function pair(): { shell: ControlRpc; server: ControlRpc; cut(): void } {
  let cut = false
  const shell: ControlRpc = createControlRpc((frame) => {
    if (!cut) setImmediate(() => server.receive(frame))
  })
  const server: ControlRpc = createControlRpc((frame) => {
    if (!cut) setImmediate(() => shell.receive(frame))
  })
  return {
    shell,
    server,
    cut() {
      cut = true
    },
  }
}

test('a call is answered with what its handler returns', async () => {
  const { shell, server } = pair()
  server.handle('workspaces.prepareAtBoot', async (params) => ({ prepared: (params as { n: number }).n + 1 }))
  assert.deepEqual(await shell.call('workspaces.prepareAtBoot', { n: 1 }), { prepared: 2 })
})

test('either end may ask', async () => {
  const { shell, server } = pair()
  shell.handle('cipher.available', () => true)
  assert.equal(await server.call('cipher.available'), true)
})

test('a thrown handler answers as itself failing, with its message', async () => {
  const { shell, server } = pair()
  server.handle('boom', () => {
    throw new Error('the registry is not hydrated')
  })
  await assert.rejects(shell.call('boom'), (error: unknown) => {
    assert.ok(error instanceof ControlRpcError)
    assert.equal(error.code, 'failed')
    assert.match(error.message, /not hydrated/)
    return true
  })
})

test('a method nobody serves is refused by name', async () => {
  const { shell } = pair()
  await assert.rejects(shell.call('nothing.here'), (error: unknown) => {
    assert.ok(error instanceof ControlRpcError)
    assert.equal(error.code, 'no_handler')
    return true
  })
})

test('a call that is never answered times out', async () => {
  vi.useFakeTimers()
  try {
    const sent: ControlRpcFrame[] = []
    const rpc = createControlRpc((frame) => sent.push(frame))
    const call = rpc.call('slow', undefined, { timeoutMs: 1_000 })
    const settled = assert.rejects(call, (error: unknown) => (error as ControlRpcError).code === 'timeout')
    await vi.advanceTimersByTimeAsync(1_001)
    await settled
    assert.equal(sent.length, 1)
  } finally {
    vi.useRealTimers()
  }
})

test('closing rejects what is out, and every call until the channel is reopened', async () => {
  const sent: ControlRpcFrame[] = []
  const rpc = createControlRpc((frame) => sent.push(frame))
  const out = rpc.call('cipher.seal', new Uint8Array([1]))
  rpc.close('Studio server stopped.')
  await assert.rejects(out, (error: unknown) => (error as ControlRpcError).code === 'unavailable')
  await assert.rejects(rpc.call('again'), /Studio server stopped/)
  rpc.reopen((frame) => sent.push(frame))
  const again = rpc.call('again')
  const request = sent.at(-1) as Extract<ControlRpcFrame, { t: 'req' }>
  rpc.receive({ t: 'res', id: request.id, ok: true, value: 'answered' })
  assert.equal(await again, 'answered')
})

test('an answer that arrives after its call was given up on is dropped', () => {
  const rpc = createControlRpc(() => undefined)
  assert.equal(rpc.receive({ t: 'res', id: 999, ok: true, value: null }), true)
})

test('events reach every listener, and one that throws does not stop the rest', async () => {
  const { shell, server } = pair()
  const heard: unknown[] = []
  server.on('hint', () => {
    throw new Error('first listener')
  })
  server.on('hint', (payload) => heard.push(payload))
  shell.emit('hint', { power: 'suspend' })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(heard, [{ power: 'suspend' }])
})

test('a frame that is not the RPC is left for the caller', () => {
  const rpc = createControlRpc(() => undefined)
  assert.equal(rpc.receive({ t: 'ping', seq: 1 }), false)
  assert.equal(rpc.receive(null), false)
  assert.equal(rpc.receive('text'), false)
})

test('a channel cut mid-call leaves the call to its deadline unless closed', async () => {
  const { shell, server, cut } = pair()
  server.handle('slow', () => new Promise((resolve) => setTimeout(() => resolve('late'), 20)))
  const call = shell.call('slow')
  cut()
  shell.close('Studio server stopped.')
  await assert.rejects(call, /Studio server stopped/)
})
