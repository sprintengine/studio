import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationEvent, ConversationMcpServer } from '../../shared/conversation-runtime'
import type { ExecutionHostId } from '../../shared/execution-host'
import { CLAUDE_AGENT_PROVIDER_ID, claudeMcpServers, createClaudeAgentProvider } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// A Claude chat's child loads the person's user settings only, so neither the
// gateway pinned into a workspace's `.mcp.json` nor a connector written there
// would reach it. Both are handed to the SDK's `mcpServers` instead.

const GATEWAY: ConversationMcpServer = {
  id: 'sprintengine-studio',
  name: 'SprintEngine Studio',
  transport: 'stdio',
  command: '/Applications/Studio.app/launcher',
  args: ['mcp'],
  env: { SPRINTENGINE_USER_DATA_DIR: '/Users/dev/Library/Application Support/Studio' },
}
const RAILWAY: ConversationMcpServer = {
  id: 'railway',
  name: 'Railway',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@railway/mcp'],
}

function harness(gateway: ConversationMcpServer | null | 'throws') {
  const options: Record<string, unknown>[] = []
  const gatewayAskedFor: Array<{ hostId?: ExecutionHostId }> = []
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    options.push(params.options)
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    let ended = false
    void (async () => {
      for await (const _message of params.prompt) {
        pending.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'mcp' })
        wake?.()
      }
    })()
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      interrupt: async () => {
        ended = true
        wake?.()
      },
      setPermissionMode: async () => undefined,
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: (input) => ({
      PATH: '/usr/bin',
      SPRINTENGINE_WORKSPACE_ID: input.workspaceId,
      SPRINTENGINE_AGENT_ID: input.agentId,
    }),
    // A WSL machine that is always ready; its child is never spawned here.
    prepareWslTarget: async () => ({ distro: 'Ubuntu', agentStateSocketPath: '/run/user/1000/agent.sock' }),
    resolveStudioMcpServer: async (input) => {
      gatewayAskedFor.push(input)
      if (gateway === 'throws') throw new Error('no launcher')
      return gateway
    },
  })
  const turn = (overrides: Partial<MockAdapterTurnInput> = {}): MockAdapterTurnInput => ({
    sessionId: 'conv_1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    workspaceRoot: '/Users/dev/app',
    turnId: 'turn_1',
    requestId: 'approval_1',
    message: 'hello',
    ...overrides,
  })
  const firstTurn = async (overrides: Partial<MockAdapterTurnInput> = {}) => {
    await adapter.startSession(turn(overrides))
    const events: ConversationEvent[] = []
    for await (const event of (await adapter.sendTurn(turn(overrides))) as AsyncIterable<ConversationEvent>)
      events.push(event)
    return options.at(-1)!
  }
  return { adapter, firstTurn, gatewayAskedFor }
}

test('claude-agent-provider mcp servers', async () => {
  // The gateway reaches every chat, carrying the chat's identity for the launch cap.
  {
    const { adapter, firstTurn, gatewayAskedFor } = harness(GATEWAY)
    assert.equal(adapter.acceptsMcpServers, true)
    const options = await firstTurn()
    assert.deepEqual(options.settingSources, ['user'])
    assert.deepEqual(options.mcpServers, {
      'sprintengine-studio': {
        type: 'stdio',
        command: '/Applications/Studio.app/launcher',
        args: ['mcp'],
        env: {
          SPRINTENGINE_USER_DATA_DIR: '/Users/dev/Library/Application Support/Studio',
          SPRINTENGINE_WORKSPACE_ID: 'ws-1',
          SPRINTENGINE_AGENT_ID: 'agent-1',
          SPRINTENGINE_AGENT_CLI: 'claude-code',
        },
      },
    })
    assert.deepEqual(gatewayAskedFor, [{}])
    await adapter.disposeAll()
  }

  // A connector run's server rides beside it.
  {
    const { adapter, firstTurn } = harness(GATEWAY)
    const options = await firstTurn({ mcpServers: [RAILWAY] })
    assert.deepEqual(Object.keys(options.mcpServers as object), ['sprintengine-studio', 'railway'])
    assert.deepEqual((options.mcpServers as Record<string, unknown>).railway, {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@railway/mcp'],
    })
    await adapter.disposeAll()
  }

  // No gateway (or one that could not be resolved) leaves it out; the chat still runs.
  for (const gateway of [null, 'throws'] as const) {
    const { adapter, firstTurn } = harness(gateway)
    assert.equal((await firstTurn()).mcpServers, undefined)
    await adapter.disposeAll()
  }

  // A chat on a WSL machine asks for that machine's gateway.
  {
    const { firstTurn, gatewayAskedFor, adapter } = harness(null)
    await firstTurn({ cliRuntimes: { 'claude-code': { hostId: 'wsl:Ubuntu' } } })
    assert.deepEqual(gatewayAskedFor, [{ hostId: 'wsl:Ubuntu' }])
    await adapter.disposeAll()
  }

  // The rendering: HTTP and SSE with a bearer token the CLI expands, Windows
  // paths for a child in WSL, and a server with nothing to start left out.
  assert.deepEqual(
    claudeMcpServers([
      {
        id: 'linear',
        name: 'Linear',
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
        envVarNames: ['LINEAR_TOKEN'],
      },
      { id: 'events', name: 'Events', transport: 'sse', url: 'https://example.com/sse', headers: { 'X-Team': 'acme' } },
      { id: 'broken', name: 'Broken', transport: 'stdio' },
    ]),
    {
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' } },
      events: { type: 'sse', url: 'https://example.com/sse', headers: { 'X-Team': 'acme' } },
    },
  )
  assert.deepEqual(
    claudeMcpServers(
      [{ id: 'local', name: 'Local', transport: 'stdio', command: 'C:\\tools\\mcp.exe', args: ['--x'] }],
      {
        wsl: true,
      },
    ).local,
    { type: 'stdio', command: '/mnt/c/tools/mcp.exe', args: ['--x'] },
  )
})
