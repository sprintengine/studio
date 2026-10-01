import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { TAILNET_IDENTITY_PATH, TAILNET_MCP_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// A paired machine built before Manual and Auto came back reads either as No
// flag. Asked for one, it would run the chat on something the person did not
// choose while this machine showed the one they did, so neither is sent to a
// machine whose handshake leaves `conversation-permission-modes` out.

/** A machine that answers pairing and identity with the capabilities given, and 404s the rest. */
async function pairedMachine(capabilities: string[] | undefined) {
  const toolCalls: string[] = []
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
    request.resume()
    if (path === TAILNET_PAIR_PATH) return json(200, { ...device, deviceToken: 'device-token' })
    if (path === TAILNET_IDENTITY_PATH) return json(200, device)
    toolCalls.push(path)
    return json(404, { error: { code: 'not_found', message: `No tailnet gateway route for ${path}.` } })
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const port = (peer.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-permission-modes-'))
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
    toolCalls,
    async close() {
      mesh.shutdown()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('a machine that leaves the four modes out is not sent Manual or Auto, and says why', async () => {
  const older = await pairedMachine(['events', 'upload', 'conversations', 'conversation-models'])
  try {
    const key = { connectionId: older.connectionId, workspaceId: 'w', agentId: 'a' }
    const before = older.toolCalls.filter((path) => path === TAILNET_MCP_PATH).length
    for (const preset of ['manual', 'auto']) {
      const switched = await older.mesh.conversationCommand({ key, command: { kind: 'setPermissionPreset', preset } })
      assert.equal(!switched.ok && switched.code, 'unsupported_permission_preset', preset)
      assert.match(!switched.ok ? switched.message : '', /takes only Bypass or No flag/)
      const created = await older.mesh.createConversation({
        connectionId: older.connectionId,
        workspaceId: 'w',
        permissionPreset: preset,
      })
      assert.equal(!created.ok && created.code, 'unsupported_permission_preset', preset)
    }
    assert.equal(
      older.toolCalls.filter((path) => path === TAILNET_MCP_PATH).length,
      before,
      'no tool was called over there',
    )

    // The two presets it knows are still sent.
    const created = await older.mesh.createConversation({
      connectionId: older.connectionId,
      workspaceId: 'w',
      permissionPreset: 'bypass',
    })
    assert.notEqual(!created.ok && created.code, 'unsupported_permission_preset')
    assert.ok(older.toolCalls.filter((path) => path === TAILNET_MCP_PATH).length > before, 'a bypass chat is asked for')
  } finally {
    await older.close()
  }
})

test('a machine that advertises the four modes is sent Manual and Auto', async () => {
  const current = await pairedMachine(['events', 'upload', 'conversations', 'conversation-permission-modes'])
  try {
    const created = await current.mesh.createConversation({
      connectionId: current.connectionId,
      workspaceId: 'w',
      permissionPreset: 'manual',
    })
    assert.notEqual(!created.ok && created.code, 'unsupported_permission_preset')
    assert.ok(
      current.toolCalls.some((path) => path === TAILNET_MCP_PATH),
      'the chat is asked for',
    )
  } finally {
    await current.close()
  }
})
