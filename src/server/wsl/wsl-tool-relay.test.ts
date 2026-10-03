import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { connect } from '../../../packages/agent-sdk/src/client'
import type { ToolCall, ToolsetInput } from '../../../packages/agent-sdk/src/tools'
import type { ClientToolRegistry } from '../tools/client-tool-registry'
import type { WslServerConnection } from './wsl-environment-manager'
import { relayedToolArgs, relayShellToolsets } from './wsl-tool-relay'

async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

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
  await waitFor(() => offers.length > 0)
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
  await waitFor(() => withdrawn.length > 0)
  assert.deepEqual(withdrawn, ['browser'], 'a toolset the shell withdraws is withdrawn there too')
})

test("an editor call's Linux paths open on Windows, and a ~ path is refused in words", () => {
  const where = { distro: 'Ubuntu', driveMountRoot: '/mnt/' }
  const out = relayedToolArgs(
    'editor',
    {
      files: [{ path: '/home/dev/repo/a.ts', range: { startLine: 3 } }, { path: 'src/b.ts' }],
      paths: ['/mnt/c/Users/dev/repo/c.ts', 'd.ts'],
      focus: { path: '/home/dev/repo/a.ts' },
    },
    where,
  )
  assert.deepEqual(out.files, [
    { path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo\\a.ts', range: { startLine: 3 } },
    { path: 'src/b.ts' },
  ])
  assert.deepEqual(out.paths, ['C:\\Users\\dev\\repo\\c.ts', 'd.ts'], 'relative paths stay the workspace’s')
  assert.deepEqual(out.focus, { path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo\\a.ts' })
  assert.deepEqual(
    relayedToolArgs('editor', { paths: ['/win/d/work/x.ts'] }, { distro: 'Ubuntu', driveMountRoot: '/win/' }).paths,
    ['D:\\work\\x.ts'],
    'a custom drive mount root is the distribution’s own',
  )
  assert.throws(() => relayedToolArgs('editor', { files: [{ path: '~/repo/a.ts' }] }, where), /absolute Linux path/u)
  const browser = { url: '/home/dev/page.html' }
  assert.equal(relayedToolArgs('browser', browser, where), browser, 'only the editor’s paths are files on Windows')
})
