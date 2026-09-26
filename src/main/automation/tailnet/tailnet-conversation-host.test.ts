import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost, readBoundedConversationUpload } from './tailnet-conversation-host'
import { MAX_ATTACHMENTS_PER_TURN, MAX_ATTACHMENT_BYTES } from '../../../shared/conversation-attachments'
import { CONVERSATION_MAX_IMAGES } from '../../../../packages/conversation-protocol/src'

async function fixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-gateway-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const adapter = createMockConversationProvider()
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
  )
  const start = () =>
    runtime.startSession({
      ...key,
      providerId: adapter.id,
      modelId: adapter.listModels()[0],
      permissionPreset: 'manual',
    })
  return {
    key,
    host,
    runtime,
    start,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('gateway lists closed history and resumes concurrent sends once under manual approval', async () => {
  const f = await fixture()
  try {
    const started = await f.start()
    assert.ok(started.ok)
    await f.runtime.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })
    await f.runtime.stopSession({ sessionId: started.session.sessionId })
    assert.equal((await f.host.list())[0].sessionId, undefined)
    const start = vi.spyOn(f.runtime, 'startSession')
    const results = await Promise.all(
      ['one', 'two'].map((commandId) => f.host.command(f.key, 'phone', commandId, { kind: 'send', message: '/tools' })),
    )
    assert.equal(start.mock.calls.length, 1)
    assert.equal(start.mock.calls[0][0].permissionPreset, 'manual')
    assert.ok(results.some((result) => result.ok))
    const live = (await f.host.list())[0]
    assert.ok(live.sessionId)
    assert.equal(live.capabilities?.images, true)
    assert.equal(f.host.resolveKey('missing', 'agent'), null)
    assert.deepEqual(f.host.resolveKey('workspace', 'agent'), f.key)
  } finally {
    await f.cleanup()
  }
})

test('failed safe resume never retries with a more permissive preset', async () => {
  const f = await fixture()
  try {
    const started = await f.start()
    assert.ok(started.ok)
    await f.runtime.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })
    await f.runtime.stopSession({ sessionId: started.session.sessionId })
    const start = vi
      .spyOn(f.runtime, 'startSession')
      .mockResolvedValue({ ok: false, message: 'Manual approval unsupported.' })
    assert.deepEqual(await f.host.command(f.key, 'phone', 'send', { kind: 'send', message: 'hello' }), {
      ok: false,
      message: 'Manual approval unsupported.',
    })
    assert.equal(start.mock.calls.length, 1)
    assert.equal(start.mock.calls[0][0].permissionPreset, 'manual')
  } finally {
    await f.cleanup()
  }
})

test('upload references are device/session bound, bounded and invalidated by size changes', async () => {
  const f = await fixture()
  try {
    assert.equal(CONVERSATION_MAX_IMAGES, MAX_ATTACHMENTS_PER_TURN)
    const started = await f.start()
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    const path = join(f.key.workspaceRoot, 'image.png')
    await writeFile(path, 'image')
    const upload = { deviceId: 'phone', sessionId, path, name: 'image.png', mediaType: 'image/png', bytes: 5 }
    const id = f.host.registerUpload!(upload)
    const send = vi.spyOn(f.runtime, 'sendTurn').mockResolvedValue({ ok: true, session: started.session })
    assert.equal(
      (await f.host.command(f.key, 'other-phone', 'wrong-device', { kind: 'send', message: '', uploadIds: [id] })).ok,
      false,
    )
    const otherSession = f.host.registerUpload!({ ...upload, sessionId: 'other-session' })
    assert.equal(
      (await f.host.command(f.key, 'phone', 'wrong-session', { kind: 'send', message: '', uploadIds: [otherSession] }))
        .ok,
      false,
    )
    assert.equal(send.mock.calls.length, 0)
    assert.equal(
      (await f.host.command(f.key, 'phone', 'valid', { kind: 'send', message: '', uploadIds: [id] })).ok,
      true,
    )
    assert.equal(send.mock.calls[0][0].attachments?.[0].dataBase64, Buffer.from('image').toString('base64'))
    await writeFile(path, 'larger image')
    assert.equal(
      (await f.host.command(f.key, 'phone', 'changed', { kind: 'send', message: '', uploadIds: [id] })).ok,
      false,
    )
    for (let index = 0; index < 32; index++) f.host.registerUpload!(upload)
    assert.equal(
      (await f.host.command(f.key, 'phone', 'evicted', { kind: 'send', message: '', uploadIds: [id] })).ok,
      false,
    )
    assert.equal(send.mock.calls.length, 1)
  } finally {
    await f.cleanup()
  }
})

test('bounded image reads refuse symlinks, directories and oversized input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-upload-'))
  try {
    const path = join(directory, 'image.png'),
      link = join(directory, 'link.png')
    await writeFile(path, 'image')
    await symlink(path, link)
    assert.equal((await readBoundedConversationUpload(path, 5)).toString(), 'image')
    await assert.rejects(readBoundedConversationUpload(link, 5))
    await assert.rejects(readBoundedConversationUpload(directory, 5))
    await assert.rejects(readBoundedConversationUpload(path, MAX_ATTACHMENT_BYTES + 1))
    await assert.rejects(readBoundedConversationUpload(path, 4))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('send preparation coalesces retries, refuses parallel turns and leaves interrupts available', async () => {
  const f = await fixture()
  try {
    const started = await f.start()
    assert.ok(started.ok)
    let complete!: () => void
    const send = vi.spyOn(f.runtime, 'sendTurn').mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        complete = resolve
      })
      return { ok: true, session: started.session }
    })
    const interrupt = vi.spyOn(f.runtime, 'interrupt').mockResolvedValue({ ok: true, session: started.session })
    const first = f.host.command(f.key, 'phone', 'stable-id', { kind: 'send', message: 'hello' })
    const retry = f.host.command(f.key, 'phone', 'stable-id', { kind: 'send', message: 'hello' })
    assert.equal(first, retry)
    assert.equal((await f.host.command(f.key, 'phone', 'another-id', { kind: 'send', message: 'other' })).ok, false)
    assert.equal((await f.host.command(f.key, 'phone', 'interrupt', { kind: 'interrupt' })).ok, true)
    assert.equal(send.mock.calls.length, 1)
    assert.equal(interrupt.mock.calls.length, 1)
    complete()
    assert.equal((await first).ok, true)
  } finally {
    await f.cleanup()
  }
})

test('remote sends cannot inherit a local bypass or CLI-managed preset', async () => {
  const f = await fixture()
  try {
    const started = await f.start()
    assert.ok(started.ok)
    for (const permissionPreset of ['bypass', 'none', undefined] as const) {
      vi.spyOn(f.runtime, 'listSessions').mockReturnValue({
        ok: true,
        sessions: [{ ...started.session, permissionPreset }],
      })
      const result = await f.host.command(f.key, 'phone', `send-${permissionPreset}`, {
        kind: 'send',
        message: 'hello',
      })
      assert.equal(result.ok, false)
      assert.match(result.message!, /explicit Manual or Auto/)
    }
  } finally {
    await f.cleanup()
  }
})
