import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { connect } from '../../../packages/agent-sdk/src/client'
import type { ToolCall, ToolsetInput } from '../../../packages/agent-sdk/src/tools'
import { desktopToolParts } from '../../main/automation/gateway-tools-parity.test-helper'
import type { McpToolRegistration } from '../../shared/modules/mcp-tools'
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

/** A relay to one WSL server, with the shell offering `shell` in the Windows registry and the gateway serving `own`. */
async function relayed(shell: ReturnType<typeof definition>[], own: McpToolRegistration[]) {
  const offers: ToolsetInput[] = []
  const calls: Array<Record<string, any>> = []
  const registry = {
    visibleTools: () => shell,
    subscribe: () => () => undefined,
    call: async (input: Record<string, any>) => {
      calls.push(input)
      return { result: { content: [{ type: 'text', text: 'ok' }] } }
    },
  } as unknown as ClientToolRegistry
  const fakeConnect = (async () => ({
    tools: {
      offer: async (toolset: ToolsetInput) => {
        offers.push(toolset)
        return {
          name: toolset.name,
          wireNames: toolset.tools.map((tool) => `${toolset.name}.${tool.name}`),
          state: 'offered',
          withdraw: async () => undefined,
        }
      },
    },
    close: () => undefined,
  })) as unknown as typeof connect
  let connected: (connection: WslServerConnection) => void = () => undefined
  relayShellToolsets({
    onConnected: (listener) => (connected = listener),
    registry,
    gatewayTools: () => own,
    connectClient: fakeConnect,
  })
  connected({
    distro: 'Ubuntu',
    backend: { isOpen: () => true, onClose: () => undefined } as unknown as WslServerConnection['backend'],
    driveMountRoot: '/mnt/',
    environmentId: 'env',
    open: async () => assert.fail('the fake client opens nothing'),
  })
  // Offered one after another: done once the count holds still.
  let count = -1
  await waitFor(() => {
    const settled = offers.length > 0 && offers.length === count
    count = offers.length
    return settled
  })
  return { offers, calls }
}

function agentCall(toolset: string, tool: string): ToolCall {
  return {
    id: 'call-1',
    toolset,
    tool,
    conversation: { workspaceId: 'ws-1', agentId: 'a1' },
    agent: {},
    context: {
      connection: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'a1', cliId: 'claude-code' },
      conversation: { workspaceId: 'ws-1', agentId: 'a1' },
    },
    signal: new AbortController().signal,
    redelivered: false,
    progress: () => undefined,
  } as ToolCall
}

test('in process, a WSL server is offered all six of the shell’s toolsets, though only two are client toolsets on Windows', async () => {
  // In process the shell offers the browser and the canvas; the editor,
  // tours, terminals and agent launches are the Windows gateway's own tools.
  const parts = desktopToolParts()
  const { offers } = await relayed(
    [definition('browser', 'navigate'), definition('canvas', 'list')],
    [...parts.editor, ...parts.tour, ...parts.core, ...parts.automation, ...parts.tailnet],
  )
  const names = offers.map((offer) => offer.name)
  for (const toolset of ['browser', 'canvas', 'editor', 'tour', 'terminal', 'agent'])
    assert.ok(names.includes(toolset), `${toolset} is offered; offered: ${names.join(', ')}`)
  const wire = offers.flatMap((offer) => offer.tools.map((tool) => `${offer.name}.${tool.name}`))
  for (const name of ['editor.open', 'tour.create', 'terminal.create', 'agent.launch', 'agent.status'])
    assert.ok(wire.includes(name), name)
})

test('the Windows side’s own families go too, but for the conversation the WSL server serves and remote control', async () => {
  const parts = desktopToolParts()
  const review: McpToolRegistration = {
    name: 'review_list_pending',
    description: 'Reviews waiting.',
    inputSchema: { type: 'object' },
    handler: async () => ({ content: [{ type: 'text', text: 'none' }] }),
  }
  const { offers } = await relayed([], [...parts.core, ...parts.automation, ...parts.tailnet, review])
  assert.deepEqual(offers.map((offer) => offer.name).sort(), [
    'agent',
    'backlog',
    'cli',
    'marketplace',
    'module',
    'review',
    'schedule',
    'terminal',
    'workspace',
  ])
  const cli = offers.find((offer) => offer.name === 'cli')!
  assert.deepEqual(
    cli.tools.map((tool) => tool.name),
    ['runtime_list'],
    'a second dot crosses as an underscore: an agent reads cli_runtime_list either way',
  )
  const reviews = offers.find((offer) => offer.name === 'review')!
  assert.deepEqual(
    reviews.tools.map((tool) => tool.name),
    ['list_pending'],
  )
  assert.equal(reviews.reach, 'all', 'a module’s toolset reaches every agent on the server, as on Windows')
  const backlog = offers.find((offer) => offer.name === 'backlog')!
  assert.equal(backlog.tools.find((tool) => tool.name === 'work')?.mutates, true)
  assert.equal(backlog.tools.find((tool) => tool.name === 'list')?.mutates, false)
})

test("a call to one of the Windows side's own tools runs its handler as the WSL agent, its paths respelled", async () => {
  const seen: Array<{ name: string; args: Record<string, unknown>; metadata: unknown }> = []
  const own = (name: string): McpToolRegistration => ({
    name,
    description: name,
    inputSchema: { type: 'object' },
    handler: async (args, context) => {
      seen.push({ name, args, metadata: context?.metadata })
      return { content: [{ type: 'text', text: 'done' }] }
    },
  })
  const { offers, calls } = await relayed(
    [definition('browser', 'navigate')],
    [own('editor.open'), own('workspace.create'), own('cli.runtime.list')],
  )
  const handler = (toolset: string, tool: string) =>
    offers.find((offer) => offer.name === toolset)!.tools.find((entry) => entry.name === tool)!.handler

  await handler('editor', 'open')({ files: [{ path: '/home/dev/repo/a.ts' }] }, agentCall('editor', 'open'))
  assert.deepEqual(seen[0], {
    name: 'editor.open',
    args: { files: [{ path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo\\a.ts' }] },
    metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'a1', cliId: 'claude-code' },
  })
  await handler('workspace', 'create')({ folderPath: '/mnt/c/Users/dev/repo' }, agentCall('workspace', 'create'))
  assert.deepEqual(seen[1].args, { folderPath: 'C:\\Users\\dev\\repo' })
  const refused = await handler('workspace', 'create')({ folderPath: '~/repo' }, agentCall('workspace', 'create'))
  assert.match(JSON.stringify(refused), /invalid_path/u)
  await handler('cli', 'runtime_list')({}, agentCall('cli', 'runtime_list'))
  assert.equal(seen.at(-1)?.name, 'cli.runtime.list', 'the call reaches the tool by its own name')
  assert.equal(calls.length, 0, 'none of them went through the registry, which holds only the shell’s')
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

test('a toolset is offered with each tool name once, and offered again when its tools change but not their number', async () => {
  const own = (name: string): McpToolRegistration => ({
    name,
    description: name,
    inputSchema: { type: 'object' },
    handler: async () => ({ content: [{ type: 'text', text: name }] }),
  })
  // `backlog.list` and a module's `backlog_list` cross under one name; a
  // toolset naming a tool twice would be refused whole.
  const { offers } = await relayed([], [own('backlog.list'), own('backlog_list'), own('backlog.read')])
  const backlog = offers.find((offer) => offer.name === 'backlog')
  assert.deepEqual(backlog?.tools.map((tool) => tool.name).sort(), ['list', 'read'])
  assert.deepEqual(
    await backlog?.tools[0].handler({}, agentCall('backlog', 'list')),
    { content: [{ type: 'text', text: 'backlog.list' }] },
    'the first registered wins',
  )

  const offered: ToolsetInput[] = []
  let visible = [definition('browser', 'navigate')]
  let changed: () => void = () => undefined
  const registry = {
    visibleTools: () => visible,
    subscribe: (listener: () => void) => ((changed = listener), () => undefined),
    call: async () => ({ result: { content: [] } }),
  } as unknown as ClientToolRegistry
  let connected: (connection: WslServerConnection) => void = () => undefined
  relayShellToolsets({
    onConnected: (listener) => (connected = listener),
    registry,
    connectClient: (async () => ({
      tools: {
        offer: async (toolset: ToolsetInput) => {
          offered.push(toolset)
          return {
            name: toolset.name,
            wireNames: toolset.tools.map((tool) => `${toolset.name}.${tool.name}`),
            state: 'offered',
            withdraw: async () => undefined,
          }
        },
      },
      close: () => undefined,
    })) as unknown as typeof connect,
  })
  connected({
    distro: 'Ubuntu',
    backend: { isOpen: () => true, onClose: () => undefined } as unknown as WslServerConnection['backend'],
    driveMountRoot: '/mnt/',
    environmentId: 'env',
    open: async () => assert.fail('the fake client opens nothing'),
  })
  await waitFor(() => offered.length === 1)
  visible = [definition('browser', 'click')]
  changed()
  await waitFor(() => offered.length === 2)
  assert.deepEqual(
    offered[1].tools.map((tool) => tool.name),
    ['click'],
  )
})
