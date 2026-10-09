import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { TAILNET_IDENTITY_PATH, TAILNET_MCP_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// A chat on a paired machine runs that machine's skills: the composer lists
// them from it (`workspace.extensions`), New chat names them to
// `conversation.create`, and a machine that has not said it takes them is
// refused here in words, before anything is asked, rather than sent an
// argument an older handler would skip.

/** A machine with the capabilities given that records each tool call and answers both tools. */
async function pairedMachine(capabilities: string[]) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const device = {
    deviceId: 'device-1',
    deviceName: 'mac-mini',
    scopes: ['workspace:read', 'conversation:read', 'conversation:operate'],
    transportVersion: 2,
    capabilities,
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
      if (path === TAILNET_MCP_PATH) {
        const call = JSON.parse(body) as {
          id?: unknown
          params?: { name?: string; arguments?: Record<string, unknown> }
        }
        const tool = call.params?.name ?? ''
        calls.push({ tool, args: call.params?.arguments ?? {} })
        const answer = (structuredContent: unknown) =>
          json(200, { jsonrpc: '2.0', id: call.id, result: { structuredContent } })
        if (tool === 'conversation.create')
          return answer({ ok: true, conversation: { workspaceId: 'ws-new', agentId: 'agent-1', name: 'Review' } })
        if (tool === 'workspace.extensions')
          return answer({
            ok: true,
            workspaceId: 'ws-1',
            skills: [
              {
                id: 'systematic-debugging',
                name: 'systematic-debugging',
                description: 'Find the root cause first.',
                source: 'custom',
                harnesses: ['claude'],
                installState: 'installed',
                sourceRepo: 'acme/skills',
              },
              { id: 'backlog', name: 'backlog', source: 'builtin', harnesses: [], installState: 'available' },
              { id: '../escape', name: 'nope', source: 'custom', installState: 'installed' },
            ],
            servers: [
              { id: 'github', transport: 'http', scope: 'user', status: 'connected', toolCount: 38 },
              { id: 'figma', transport: 'http', scope: 'session', status: 'failed', error: 'ECONNREFUSED' },
              { id: 'odd', transport: 'stdio', scope: 'workspace', status: 'exploded' },
            ],
          })
      }
      return json(404, { error: { code: 'not_found', message: `No tailnet gateway route for ${path}.` } })
    })
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const port = (peer.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-remote-skills-'))
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
    calls,
    async close() {
      mesh.shutdown()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const SKILLS = ['conversations', 'workspace-extensions', 'new-chat-skills', 'conversation-send-skills']

test('a machine that takes skills is asked for a chat with them', async () => {
  const machine = await pairedMachine(SKILLS)
  try {
    const created = await machine.mesh.createConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      prompt: 'Find why the test is flaky',
      skills: ['systematic-debugging', 'systematic-debugging', 'backlog'],
    })
    assert.ok(created.ok, created.ok ? '' : created.message)
    const create = machine.calls.find((call) => call.tool === 'conversation.create')
    assert.deepEqual(create?.args.skills, ['systematic-debugging', 'backlog'], 'each once')
    assert.equal(create?.args.prompt, 'Find why the test is flaky')
  } finally {
    await machine.close()
  }
})

test('a machine that has not said it takes skills is refused before it is asked', async () => {
  const machine = await pairedMachine(['conversations'])
  try {
    const created = await machine.mesh.createConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      skills: ['systematic-debugging'],
    })
    assert.equal(created.ok, false)
    assert.ok(!created.ok && created.code === 'skills_unsupported')
    assert.ok(!created.ok && created.message.includes('Update SprintEngine Studio there'))
    assert.equal(machine.calls.length, 0, 'nothing was asked over there')
    const listed = await machine.mesh.workspaceExtensions({ connectionId: machine.connectionId, workspaceId: 'ws-1' })
    assert.ok(!listed.ok && listed.code === 'skills_unsupported')
  } finally {
    await machine.close()
  }
})

test('skill ids that are not ids are refused', async () => {
  const machine = await pairedMachine(SKILLS)
  try {
    const created = await machine.mesh.createConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      skills: ['../../etc/passwd'],
    })
    assert.ok(!created.ok && created.code === 'invalid_arguments')
    assert.equal(machine.calls.length, 0)
  } finally {
    await machine.close()
  }
})

test("a machine's skills and servers are listed for the composer, read member by member", async () => {
  const machine = await pairedMachine(SKILLS)
  try {
    const listed = await machine.mesh.workspaceExtensions({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      cli: 'claude-code',
    })
    assert.ok(listed.ok, listed.ok ? '' : listed.message)
    assert.deepEqual(machine.calls[0], {
      tool: 'workspace.extensions',
      args: { workspaceId: 'ws-1', cli: 'claude-code' },
    })
    assert.deepEqual(
      listed.extensions.skills.map((skill) => [skill.id, skill.installState, skill.sourceRepo]),
      [
        ['systematic-debugging', 'installed', 'acme/skills'],
        ['backlog', 'available', undefined],
      ],
      'an id that could name a path is dropped',
    )
    assert.deepEqual(
      listed.extensions.servers.map((server) => [server.id, server.status, server.error, server.toolCount]),
      [
        ['github', 'connected', undefined, 38],
        ['figma', 'failed', 'ECONNREFUSED', undefined],
        ['odd', undefined, undefined, undefined],
      ],
      'a status the picker cannot say is left off',
    )
  } finally {
    await machine.close()
  }
})
