import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { connect } from '../../../packages/agent-sdk/src/client'
import type { ToolCall, ToolsetInput } from '../../../packages/agent-sdk/src/tools'
import type { ClientToolRegistry } from '../tools/client-tool-registry'
import type { WslServerConnection } from './wsl-environment-manager'
import { relayShellToolsets } from './wsl-tool-relay'

function definition(toolset: string, name: string, builtIn = true) {
  return {
    toolset,
    builtIn,
    title: toolset,
    tool: { name, description: name, inputSchema: { type: 'object' } },
    wireName: `${toolset}.${name}`,
    mutates: false,
  }
}

test("a WSL agent's call runs through the Windows side's registry as that agent's own, and only the shell's toolsets go", async () => {
  const offers: ToolsetInput[] = []
  const calls: unknown[] = []
  let changed: () => void = () => undefined
  let visible = [definition('browser', 'navigate'), definition('acme-crm', 'lookup', false)]
  const registry = {
    visibleTools: () => visible,
    subscribe: (listener: () => void) => {
      changed = listener
      return () => undefined
    },
    call: async (input: unknown) => {
      calls.push(input)
      return { result: { content: [{ type: 'text', text: 'ok' }] } }
    },
  } as unknown as ClientToolRegistry
  const withdrawn: string[] = []
  const fakeConnect = (async () => ({
    tools: {
      offer: async (toolset: ToolsetInput) => {
        offers.push(toolset)
        return {
          name: toolset.name,
          wireNames: toolset.tools.map((tool) => `${toolset.name}.${tool.name}`),
          state: 'offered',
          withdraw: async () => void withdrawn.push(toolset.name),
        }
      },
    },
    close: () => undefined,
  })) as unknown as typeof connect
  let connected: (connection: WslServerConnection) => void = () => undefined
  relayShellToolsets({ onConnected: (listener) => (connected = listener), registry, connectClient: fakeConnect })
  connected({
    distro: 'Ubuntu',
    backend: { isOpen: () => true, onClose: () => undefined } as unknown as WslServerConnection['backend'],
    driveMountRoot: '/mnt/',
    environmentId: 'env',
    open: async () => assert.fail('the fake client opens nothing'),
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(
    offers.map((offer) => offer.name),
    ['browser'],
    "an app's toolset is the app's to offer, not the relay's",
  )

  const controller = new AbortController()
  const progress: unknown[] = []
  await offers[0].tools[0].handler({ url: 'http://localhost:3000' }, {
    id: 'call-1',
    toolset: 'browser',
    tool: 'navigate',
    conversation: { workspaceId: 'ws-1', agentId: 'a1' },
    agent: {},
    context: {
      connection: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'a1' },
      conversation: { workspaceId: 'ws-1', agentId: 'a1' },
    },
    signal: controller.signal,
    redelivered: false,
    progress: (update) => progress.push(update),
  } as ToolCall)
  const call = calls[0] as Record<string, any>
  assert.equal(call.toolset, 'browser')
  assert.equal(call.tool, 'navigate')
  assert.deepEqual(call.args, { url: 'http://localhost:3000' })
  assert.deepEqual(call.caller.conversation, { workspaceId: 'ws-1', agentId: 'a1' })
  assert.match(call.caller.gatewayConnectionId, /^wsl:Ubuntu:/u)
  assert.equal(call.signal, controller.signal)

  visible = []
  changed()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(withdrawn, ['browser'], 'a toolset the shell withdraws is withdrawn there too')
})
