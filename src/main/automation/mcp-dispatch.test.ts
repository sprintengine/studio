import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'vitest'

import type { McpConnectionContext, McpToolRegistration } from '../../shared/modules/mcp-tools'
import { createMcpDispatcher, JSONRPC_INVALID_REQUEST } from './mcp-dispatch'
import { createMcpSocketServer } from './mcp-socket-server'

const CONNECT = 'sprintengine.studio/connect'

function dispatcher() {
  return createMcpDispatcher({ serverName: 'test', serverVersion: '0.0.0-test', resolveTools: () => [] })
}

function freshContext(): McpConnectionContext {
  return { metadata: { kind: 'external-local' } }
}

test('a connection declares an agent once and is that agent', async () => {
  const context = freshContext()
  const outcome = await dispatcher().dispatch(CONNECT, { agentId: 'agent-a', workspaceId: 'ws-1' }, context)
  assert.deepEqual(outcome, { kind: 'no_response' })
  assert.equal(context.metadata.kind, 'studio-agent')
  assert.equal(context.metadata.agentId, 'agent-a')
  assert.equal(context.metadata.workspaceId, 'ws-1')
})

test('a declared agent cannot re-declare itself as another agent', async () => {
  const gateway = dispatcher()
  const context = freshContext()
  await gateway.dispatch(CONNECT, { agentId: 'agent-a', workspaceId: 'ws-1' }, context)
  const outcome = await gateway.dispatch(CONNECT, { agentId: 'agent-b', workspaceId: 'ws-1' }, context)
  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.kind === 'error' && outcome.code, JSONRPC_INVALID_REQUEST)
  assert.equal(context.metadata.agentId, 'agent-a', 'the first identity stands')
})

test('a declared agent cannot move itself to another workspace', async () => {
  const gateway = dispatcher()
  const context = freshContext()
  await gateway.dispatch(CONNECT, { agentId: 'agent-a', workspaceId: 'ws-1' }, context)
  const outcome = await gateway.dispatch(CONNECT, { agentId: 'agent-a', workspaceId: 'ws-2' }, context)
  assert.equal(outcome.kind, 'error')
  assert.equal(context.metadata.workspaceId, 'ws-1')
})

test('a declared agent cannot shed its identity by declaring none', async () => {
  const gateway = dispatcher()
  const context = freshContext()
  await gateway.dispatch(CONNECT, { agentId: 'agent-a', workspaceId: 'ws-1' }, context)
  const outcome = await gateway.dispatch(CONNECT, {}, context)
  assert.equal(outcome.kind, 'error')
  assert.equal(context.metadata.kind, 'studio-agent', 'still capped as the agent it declared')
  assert.equal(context.metadata.agentId, 'agent-a')
})

test('a declared agent may state the same identity again, with a new name', async () => {
  const gateway = dispatcher()
  const context = freshContext()
  await gateway.dispatch(CONNECT, { agentId: 'agent-a', workspaceId: 'ws-1', agentName: 'Scout' }, context)
  const outcome = await gateway.dispatch(
    CONNECT,
    { agentId: 'agent-a', workspaceId: 'ws-1', agentName: 'Ranger', cliId: 'codex' },
    context,
  )
  assert.deepEqual(outcome, { kind: 'no_response' })
  assert.equal(context.metadata.agentName, 'Ranger')
  assert.equal(context.metadata.cliId, 'codex')
})

test('a connection with no agent identity may still re-state what it declares', async () => {
  const gateway = dispatcher()
  const context = freshContext()
  await gateway.dispatch(CONNECT, { workspaceId: 'ws-1' }, context)
  const outcome = await gateway.dispatch(CONNECT, { workspaceId: 'ws-2' }, context)
  assert.deepEqual(outcome, { kind: 'no_response' })
  assert.equal(context.metadata.kind, 'external-local')
  assert.equal(context.metadata.workspaceId, 'ws-2')
})

test('over the local socket, a refused re-declaration leaves every later call attributed to the first agent', async () => {
  const socketPath = join(mkdtempSync(join(tmpdir(), 'se-dispatch-sock-')), 'automation.sock')
  const attributed: Array<string | undefined> = []
  const logged: string[] = []
  const whoami: McpToolRegistration = {
    name: 'workspace.list',
    description: 'test tool',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, context) => {
      attributed.push(context?.metadata.agentId)
      return { content: [{ type: 'text', text: '{}' }], structuredContent: {} }
    },
  }
  const server = createMcpSocketServer({
    socketPath,
    serverName: 'test',
    serverVersion: '0.0.0-test',
    resolveTools: () => [whoami],
    log: (message) => logged.push(message),
  })
  await server.start()
  const socket = connect(socketPath)
  try {
    socket.setEncoding('utf8')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const answered: number[] = []
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const id = (JSON.parse(line) as { id?: number }).id
        if (typeof id === 'number') answered.push(id)
      }
    })
    const frame = (payload: Record<string, unknown>) => `${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`
    socket.write(frame({ method: CONNECT, params: { agentId: 'agent-a', workspaceId: 'ws-1' } }))
    socket.write(frame({ id: 1, method: 'tools/call', params: { name: 'workspace.list', arguments: {} } }))
    socket.write(frame({ method: CONNECT, params: { agentId: 'agent-b', workspaceId: 'ws-1' } }))
    socket.write(frame({ id: 2, method: 'tools/call', params: { name: 'workspace.list', arguments: {} } }))
    const deadline = Date.now() + 5_000
    while (answered.length < 2) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for two answers (got ${answered.length})`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.deepEqual(attributed, ['agent-a', 'agent-a'])
    assert.equal(logged.length, 1)
    assert.match(logged[0], /refused sprintengine\.studio\/connect/u)
  } finally {
    socket.destroy()
    await server.stop()
    rmSync(dirname(socketPath), { recursive: true, force: true })
  }
})
