import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createModuleHostServiceDispatcher } from './module-host-service-ipc'

const backlog = {
  calls: [] as unknown[][],
  updateStatus(...args: unknown[]) {
    this.calls.push(args)
    return Promise.resolve({ ok: true })
  },
  list() {
    return Promise.resolve({ ok: true, items: [] })
  },
  create() {
    throw new Error('disk full')
  },
}

const dispatch = createModuleHostServiceDispatcher((key) => (key === 'backlog.module-service' ? backlog : undefined))

test('a call reaches the registry with the calling module id first', async () => {
  const result = await dispatch(null, {
    moduleId: 'task-board',
    service: 'backlog',
    method: 'updateStatus',
    args: ['ws-1', 'backlog/a.md', 'ready'],
  })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(backlog.calls, [['task-board', 'ws-1', 'backlog/a.md', 'ready']])
})

test('only the listed services and methods are reachable, and every refusal is data', async () => {
  assert.deepEqual(await dispatch(null, { moduleId: 'm', service: 'conversation', method: 'create', args: [] }), {
    ok: false,
    code: 'unavailable',
    message: 'There is no host service "conversation" a module can call.',
  })
  // `list` exists on the registry, but the renderer reads through its own reader.
  const listed = (await dispatch(null, { moduleId: 'm', service: 'backlog', method: 'list', args: [] })) as {
    code: string
  }
  assert.equal(listed.code, 'invalid_input')
  const anonymous = (await dispatch(null, { service: 'backlog', method: 'updateStatus', args: [] })) as {
    code: string
  }
  assert.equal(anonymous.code, 'invalid_input')
  const missing = (await dispatch(null, { moduleId: 'm', service: 'usage', method: 'query', args: [{}] })) as {
    code: string
  }
  assert.equal(missing.code, 'unavailable')
  assert.deepEqual(await dispatch(null, { moduleId: 'm', service: 'backlog', method: 'create', args: [] }), {
    ok: false,
    code: 'backlog_unavailable',
    message: 'disk full',
  })
  assert.equal(((await dispatch(null, undefined)) as { ok: boolean }).ok, false)
})
