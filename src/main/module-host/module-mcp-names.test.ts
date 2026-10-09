import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { CapabilityManifest } from '../../shared/modules/manifest'
import { coreMcpToolConflict, mcpToolWireName, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import { createStudioGatewayTools } from '../automation/studio-gateway-tools'
import { createFakeIpcMain } from './ipc-main-fake.test-helper'
import { createMainKernel } from './main-host'

// Module MCP tool names against the gateway's own. A collision with a core
// tool used to be a warning in the diagnostics log while the module's tool was
// silently never served; it is a registration error now, naming the core tool.

const CORE = ['backlog.list', 'workspace.create', 'conversation.create']

function manifest(id: string): CapabilityManifest {
  return {
    id,
    displayName: id,
    version: 1,
    defaultEnabled: true,
    source: 'third-party',
    permissions: ['mcp:tools'],
    engines: { hostApi: 1 },
  }
}

function tool(name: string, answer = name): McpToolRegistration {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    mutates: false,
    handler: async (_args, context) => ({
      content: [{ type: 'text', text: answer }],
      structuredContent: { answer, metadata: context?.metadata ?? null },
    }),
  }
}

function kernel() {
  return createMainKernel(createFakeIpcMain().ipcMain, {
    resolveModuleManifest: (id) => manifest(id),
    coreMcpToolNames: () => CORE,
  })
}

test('the wire name is what an MCP client files the tool under', () => {
  assert.equal(mcpToolWireName('backlog.list'), 'backlog_list')
  assert.equal(mcpToolWireName(' Decisions.Record '), 'decisions_record')
})

test('a module tool named like a core tool is refused, naming the core tool', () => {
  assert.throws(
    () => kernel().hostFor('decision-log').registerMcpTools([tool('backlog_list')]),
    /collides with the core gateway tool "backlog\.list"/,
  )
  assert.throws(
    () => kernel().hostFor('decision-log').registerMcpTools([tool('workspace.create')]),
    /collides with the core gateway tool "workspace\.create"/,
  )
})

test("a name in one of the shell's own families is refused", () => {
  assert.equal(coreMcpToolConflict('browser_click', []), 'browser.*')
  assert.equal(coreMcpToolConflict('canvas.paint', []), 'canvas.*')
  assert.equal(coreMcpToolConflict('browsers_click', []), null)
  assert.throws(
    () => kernel().hostFor('decision-log').registerMcpTools([tool('terminal_run')]),
    /collides with the core gateway tool "terminal\.\*"/,
  )
})

test('a refused batch registers none of its tools', () => {
  const host = kernel()
  assert.throws(() => host.hostFor('decision-log').registerMcpTools([tool('decisions.record'), tool('backlog_list')]))
  assert.deepEqual(host.mcpToolRegistrations(), [])
})

test('names that are one name to a client collide across modules and within a batch', () => {
  const host = kernel()
  host.hostFor('decision-log').registerMcpTools([tool('decisions.record')])
  assert.throws(
    () => host.hostFor('other').registerMcpTools([tool('decisions_record')]),
    /already registered by module "decision-log" \(as "decisions\.record"\)/,
  )
  assert.throws(
    () => host.hostFor('third').registerMcpTools([tool('notes.add'), tool('notes_add')]),
    /registered twice by module "third" \(also as "notes\.add"\)/,
  )
})

test('names of your own register and are served', () => {
  const host = kernel()
  host.hostFor('decision-log').registerMcpTools([tool('decisions.record'), tool('handoff_latest')])
  assert.deepEqual(
    host.mcpToolRegistrations().map((entry) => entry.registration.name),
    ['decisions.record', 'handoff_latest'],
  )
})

test('a module tool always hears whether the caller was verified', async () => {
  const host = kernel()
  host.hostFor('decision-log').registerMcpTools([tool('decisions.record')])
  const resolve = createStudioGatewayTools({
    appTools: CORE.map((name) => tool(name)),
    resolveModuleTools: () => host.mcpToolRegistrations(),
    isModuleEnabled: () => true,
  })
  const served = resolve().find((registration) => registration.name === 'decisions.record')
  assert.ok(served)

  const declared = await served.handler({}, { metadata: { kind: 'studio-agent', agentId: 'agent-1' } })
  assert.deepEqual((declared.structuredContent?.metadata as { verified?: boolean }).verified, false)

  const proven = await served.handler(
    {},
    { metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-1', verified: true } },
  )
  assert.deepEqual((proven.structuredContent?.metadata as { verified?: boolean }).verified, true)
  assert.deepEqual([...resolve.coreToolNames()].sort(), [...CORE].sort())
})
