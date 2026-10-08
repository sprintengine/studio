import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { TAILNET_IDENTITY_PATH, TAILNET_MCP_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// A New chat on a paired machine runs at the effort the picker shows only
// where that machine keeps one (`new-chat-effort`). An older build's
// `conversation.create` skips an argument it does not know, so the effort is
// sent to a machine that advertises it and to no other, and the browse New
// chat reads says which kind of machine it is.

/** A machine that answers pairing and identity with the capabilities given, and records every tool call's body. */
async function pairedMachine(capabilities: string[] | undefined) {
  const toolBodies: string[] = []
  const device = {
    deviceId: 'device-1',
    deviceName: 'dev-macbook-air',
    scopes: ['conversation:read', 'conversation:operate'],
    transportVersion: 2,
    ...(capabilities ? { capabilities } : {}),
  }
  const peer: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://peer.invalid').pathname
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    request.on('end', () => {
      if (path === TAILNET_PAIR_PATH) return json(200, { ...device, deviceToken: 'device-token' })
      if (path === TAILNET_IDENTITY_PATH) return json(200, device)
      if (path === TAILNET_MCP_PATH) toolBodies.push(body)
      return json(404, { error: { code: 'not_found', message: `No tailnet gateway route for ${path}.` } })
    })
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const port = (peer.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-new-chat-effort-'))
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => dir,
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
  })
  const paired = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', port, 'pairing-token') })
  assert.ok(paired.ok, paired.ok ? '' : paired.message)
  await mesh.checkReachability(paired.connection.id)
  return {
    mesh,
    connectionId: paired.connection.id,
    toolBodies,
    async close() {
      mesh.shutdown()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const createCalls = (bodies: string[]) => bodies.filter((body) => body.includes('conversation.create'))

test('a machine that keeps a New chat’s effort is sent it, and its browse says so', async () => {
  const current = await pairedMachine(['conversations', 'new-chat-effort'])
  try {
    const browse = await current.mesh.browse(current.connectionId)
    assert.ok(browse.capabilities?.includes('new-chat-effort'))
    await current.mesh.createConversation({ connectionId: current.connectionId, workspaceId: 'w', effort: 'high' })
    const [create] = createCalls(current.toolBodies)
    assert.ok(create, 'the chat is asked for')
    assert.match(create!, /"effort":"high"/)
  } finally {
    await current.close()
  }
})

test('a machine that does not keep one is never sent an effort', async () => {
  for (const capabilities of [['conversations'], undefined]) {
    const older = await pairedMachine(capabilities)
    try {
      const browse = await older.mesh.browse(older.connectionId)
      assert.equal(browse.capabilities?.includes('new-chat-effort') ?? false, false)
      await older.mesh.createConversation({ connectionId: older.connectionId, workspaceId: 'w', effort: 'high' })
      const [create] = createCalls(older.toolBodies)
      assert.ok(create, 'the chat is still asked for')
      assert.doesNotMatch(create!, /"effort"/)
    } finally {
      await older.close()
    }
  }
})
