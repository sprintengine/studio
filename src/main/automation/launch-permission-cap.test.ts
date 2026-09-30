import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AgentLaunchRequest } from '../../shared/agent-launch'
import type { AutomationDefinition } from '../../shared/automations/contracts'
import type { CliPermissionPreset } from '../../shared/cli-permission-preset'
import type { TerminalSessionSnapshot } from '../../shared/electron-api'
import type { McpConnectionContext, McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { Workspace } from '../../renderer/src/types/workspace'
import type { ConversationLaunchRequest } from '../conversation-launch-service'
import { createAutomationTools, type AutomationBackends } from './automation-tools'
import { createConversationTools } from './conversation-tools'
import { createAgentPermissionResolver, type AgentPermissionResolver } from './launch-permission-cap'

const WORKSPACE: Workspace = {
  id: 'ws-1',
  name: 'App',
  mode: 'standard',
  folderPath: '/Users/dev/app',
  templateId: 'solo',
  layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
  agents: {},
  worktreeState: { containerPath: null, entries: {}, updatedAt: null },
  memory: { relativeRoot: null },
  editorState: { openFiles: [], activeFilePath: null },
  createdAt: 1,
} as Workspace

function snapshot(): WorkspaceSyncSnapshot {
  return {
    sequence: 1,
    state: {
      workspaces: [WORKSPACE],
      activeWorkspaceId: 'ws-1',
      primaryWorkspaceWindowId: 'primary',
      workspaceWindows: [],
    },
  } as unknown as WorkspaceSyncSnapshot
}

const AGENT_CALLER: McpConnectionContext = {
  metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-caller', cliId: 'claude-code' },
}
const EXTERNAL_CALLER: McpConnectionContext = { metadata: { kind: 'external-local' } }
const PAIRED_DEVICE: McpConnectionContext = {
  metadata: { kind: 'remote-tailnet', deviceId: 'dev-1', deviceName: 'dev-macbook-air', agentId: 'agent-caller' },
}

type Harness = {
  launches: AgentLaunchRequest[]
  chats: ConversationLaunchRequest[]
  created: unknown[]
  ran: unknown[]
  resolved: number
  call(tool: string, args: Record<string, unknown>, context: McpConnectionContext): Promise<McpToolResult>
}

/**
 * The launching tools over fake backends, the caller's preset answered by
 * `callerPreset` (null: the caller cannot be found).
 */
function harness(
  callerPreset: CliPermissionPreset | null,
  options: { automations?: AutomationDefinition[] } = {},
): Harness {
  const sessions: TerminalSessionSnapshot[] = []
  const h: Harness = {
    launches: [],
    chats: [],
    created: [],
    ran: [],
    resolved: 0,
    call: async (name, args, context) => {
      const registration = tools.find((candidate) => candidate.name === name)
      assert.ok(registration, `tool ${name} is served`)
      return registration.handler(args, context)
    },
  }
  const resolveAgentPermissionPreset: AgentPermissionResolver = () => {
    h.resolved += 1
    return callerPreset
  }
  const backends = {
    getWorkspaceSyncSnapshot: snapshot,
    listTerminalSessions: () => sessions,
    resolveAgentPermissionPreset,
    launchAgent: async (request: AgentLaunchRequest) => {
      h.launches.push(request)
      const agentId = `agent-launched-${h.launches.length}`
      const sessionId = `sess-${h.launches.length}`
      sessions.push({
        sessionId,
        kind: 'agent',
        workspaceId: 'ws-1',
        agentId,
        agentName: 'Scout',
        cli: 'claude-code',
        cwd: '/Users/dev/app',
        processAlive: true,
        suspended: false,
        visible: false,
        startedAt: 1,
        lastOutputAt: 1,
        lastInputAt: null,
        lastVisibleAt: null,
        activity: { kind: 'idle', since: 1 },
        agentRecord: { agentId, name: 'Scout', cli: 'claude-code', cliPermissionPreset: request.permissionPreset },
      } as unknown as TerminalSessionSnapshot)
      return { ok: true, workspaceId: 'ws-1', agentId, sessionId, cli: 'claude-code', executionId: sessionId }
    },
    listPlugins: () => [],
    ensureBuiltinSkillInstalled: async () => true,
    readBacklogItem: async (_root: string, relativePath: string) => ({
      ok: true,
      item: { relativePath, title: 'T', isEpic: false, status: 'ready' },
      body: '',
    }),
    backlogWrite: { addOrUpdateLink: async () => ({ ok: true, store: { schemaVersion: 1, items: [] } }) },
    listAutomationDefinitions: async () => ({ ok: true, values: options.automations ?? [] }),
    getAutomationsFrontDoor: () => ({
      createDefinition: async (input: unknown) => {
        h.created.push(input)
        return { ok: true, value: { id: 'auto-1' } }
      },
      runNow: async (input: unknown) => {
        h.ran.push(input)
        return { ok: true, value: { definition: { id: 'auto-1' }, run: { runId: 'run-1' } } }
      },
    }),
    now: () => 0,
    sleep: async () => {},
  } as unknown as AutomationBackends
  const tools: McpToolRegistration[] = [
    ...createAutomationTools(backends),
    ...createConversationTools({
      resolveAgentPermissionPreset,
      launch: async (request) => {
        h.chats.push(request)
        return {
          ok: true,
          workspaceId: 'ws-1',
          agentId: 'agent-chat-1',
          name: 'Ada',
          cli: 'claude-code',
          providerId: 'claude-agent',
          modelId: 'default',
          sessionId: 'conv-1',
        }
      },
    }),
  ]
  return h
}

// The four tools that start an agent now, with the arguments each needs.
const LAUNCHING_TOOLS: ReadonlyArray<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'agent.launch', args: { workspaceId: 'ws-1' } },
  { tool: 'terminal.create', args: { workspaceId: 'ws-1' } },
  { tool: 'backlog.work', args: { path: 'backlog/unfiled/item.md' } },
  { tool: 'conversation.create', args: { workspaceId: 'ws-1' } },
]

// The preset each launch was forwarded with, whichever service took it.
function forwarded(h: Harness): Array<CliPermissionPreset | undefined> {
  return [...h.launches, ...h.chats].map((request) => request.permissionPreset)
}

function errorCode(result: McpToolResult): string | undefined {
  return (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code
}

function errorMessage(result: McpToolResult): string {
  return (result.structuredContent as { error?: { message?: string } } | undefined)?.error?.message ?? ''
}

function spawnAgentDraft(config: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'Nightly',
    trigger: { kind: 'schedule', config: { cadence: { type: 'daily', timeLocal: '09:00' }, timezone: 'UTC' } },
    action: { kind: 'spawn-agent', config: { prompt: 'tidy up', ...config } },
  }
}

function storedAutomation(kind: string, config: Record<string, unknown>): AutomationDefinition {
  return {
    id: 'auto-1',
    name: 'Nightly',
    status: 'enabled',
    trigger: { kind: 'schedule', config: {} },
    action: { kind, config: { prompt: 'tidy up', ...config } },
  } as AutomationDefinition
}

for (const { tool, args } of LAUNCHING_TOOLS) {
  test(`${tool}: an agent on none cannot launch one on bypass`, async () => {
    const h = harness('none')
    const result = await h.call(tool, { ...args, permissionPreset: 'bypass' }, AGENT_CALLER)
    assert.equal(result.isError, true)
    assert.equal(errorCode(result), 'permission_escalation')
    assert.match(errorMessage(result), /only launch agents at that level or stricter/u)
    assert.deepEqual(forwarded(h), [], 'nothing was launched')
  })

  test(`${tool}: an agent on none cannot launch on bypass by its retired spelling either`, async () => {
    const h = harness('none')
    const result = await h.call(tool, { ...args, permissionPreset: 'bypass_all' }, AGENT_CALLER)
    assert.equal(errorCode(result), 'permission_escalation')
    assert.deepEqual(forwarded(h), [])
  })

  test(`${tool}: an agent on none that names no preset launches on none`, async () => {
    const h = harness('none')
    const result = await h.call(tool, args, AGENT_CALLER)
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
    assert.deepEqual(forwarded(h), ['none'])
  })

  test(`${tool}: an agent on none may launch on none`, async () => {
    const h = harness('none')
    const result = await h.call(tool, { ...args, permissionPreset: 'none' }, AGENT_CALLER)
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
    assert.deepEqual(forwarded(h), ['none'])
  })

  test(`${tool}: an agent on bypass may launch on bypass or none, and an omitted preset is left to the machine`, async () => {
    const h = harness('bypass')
    for (const preset of ['bypass', 'none', undefined]) {
      const result = await h.call(
        tool,
        preset === undefined ? args : { ...args, permissionPreset: preset },
        AGENT_CALLER,
      )
      assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
    }
    assert.deepEqual(forwarded(h), ['bypass', 'none', undefined])
  })

  test(`${tool}: an agent that cannot be found is capped at the strictest preset`, async () => {
    const h = harness(null)
    const refused = await h.call(tool, { ...args, permissionPreset: 'bypass' }, AGENT_CALLER)
    assert.equal(errorCode(refused), 'permission_escalation')
    const omitted = await h.call(tool, args, AGENT_CALLER)
    assert.equal(omitted.isError, undefined, JSON.stringify(omitted.structuredContent))
    assert.deepEqual(forwarded(h), ['manual'])
  })

  test(`${tool}: a caller with no agent identity launches as it did before`, async () => {
    const h = harness('none')
    // backlog.work finds its project from the caller's workspace or from a
    // folder it names; an external caller names the folder.
    const external = tool === 'backlog.work' ? { ...args, projectRoot: '/Users/dev/app' } : args
    await h.call(tool, { ...external, permissionPreset: 'bypass' }, EXTERNAL_CALLER)
    await h.call(tool, external, EXTERNAL_CALLER)
    assert.deepEqual(forwarded(h), ['bypass', undefined])
    assert.equal(h.resolved, 0, 'no agent was looked up')
  })

  test(`${tool}: a paired device launches as it did before`, async () => {
    const h = harness('none')
    const remote = tool === 'backlog.work' ? { ...args, projectRoot: '/Users/dev/app' } : args
    await h.call(tool, { ...remote, permissionPreset: 'bypass' }, PAIRED_DEVICE)
    assert.deepEqual(forwarded(h), ['bypass'])
    assert.equal(h.resolved, 0)
  })
}

test('automation.create: an agent on none cannot store a spawn-agent automation on bypass', async () => {
  const h = harness('none')
  const result = await h.call(
    'automation.create',
    { workspaceId: 'ws-1', definition: spawnAgentDraft({ permissionPreset: 'bypass' }) },
    AGENT_CALLER,
  )
  assert.equal(errorCode(result), 'permission_escalation')
  assert.deepEqual(h.created, [], 'nothing was written')
})

test('automation.create: an agent on none that names no preset stores none, not the bypass default', async () => {
  const h = harness('none')
  for (const config of [{}, { permissionPreset: '' }, { permissionPreset: 7 }]) {
    const result = await h.call(
      'automation.create',
      { workspaceId: 'ws-1', definition: spawnAgentDraft(config) },
      AGENT_CALLER,
    )
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
  }
  const stored = h.created.map(
    (input) => (input as { definition: { action: { config: { permissionPreset?: unknown } } } }).definition,
  )
  assert.deepEqual(
    stored.map((definition) => definition.action.config.permissionPreset),
    ['none', 'none', 'none'],
  )
})

test('automation.create: an agent on none may store a run-skill-loop automation, held to none', async () => {
  const h = harness('none')
  const draft = { ...spawnAgentDraft({}), action: { kind: 'run-skill-loop', config: { prompt: 'loop' } } }
  const result = await h.call('automation.create', { workspaceId: 'ws-1', definition: draft }, AGENT_CALLER)
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
  const stored = (h.created[0] as { definition: { action: { config: Record<string, unknown> } } }).definition
  assert.deepEqual(stored.action.config, { prompt: 'loop', permissionPreset: 'none' })
})

test('automation.create: an agent on none cannot store an action whose launches it cannot bound', async () => {
  const h = harness('none')
  const draft = { ...spawnAgentDraft({}), action: { kind: 'acme-deploy', config: {} } }
  const result = await h.call('automation.create', { workspaceId: 'ws-1', definition: draft }, AGENT_CALLER)
  assert.equal(errorCode(result), 'permission_escalation')
  assert.match(errorMessage(result), /"acme-deploy" action/u)
  assert.deepEqual(h.created, [])
})

test('automation.create: an agent on bypass stores the draft exactly as sent', async () => {
  const h = harness('bypass')
  const drafts = [
    spawnAgentDraft({ permissionPreset: 'bypass' }),
    spawnAgentDraft({}),
    { ...spawnAgentDraft({}), action: { kind: 'acme-deploy', config: {} } },
  ]
  for (const definition of drafts) {
    const result = await h.call('automation.create', { workspaceId: 'ws-1', definition }, AGENT_CALLER)
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
  }
  assert.deepEqual(
    h.created.map((input) => (input as { definition: unknown }).definition),
    drafts,
  )
})

test('automation.create: an agent that cannot be found is capped at the strictest preset', async () => {
  const h = harness(null)
  const refused = await h.call(
    'automation.create',
    { workspaceId: 'ws-1', definition: spawnAgentDraft({ permissionPreset: 'bypass' }) },
    AGENT_CALLER,
  )
  assert.equal(errorCode(refused), 'permission_escalation')
})

test('automation.create: a caller with no agent identity stores the draft exactly as sent', async () => {
  const h = harness('none')
  const definition = spawnAgentDraft({})
  await h.call('automation.create', { workspaceId: 'ws-1', definition }, EXTERNAL_CALLER)
  assert.deepEqual((h.created[0] as { definition: unknown }).definition, definition)
  assert.equal(h.resolved, 0)
})

test('automation.run: an agent on none cannot run an automation that launches on bypass', async () => {
  for (const config of [{ permissionPreset: 'bypass' }, {}]) {
    const h = harness('none', { automations: [storedAutomation('spawn-agent', config)] })
    const result = await h.call('automation.run', { workspaceId: 'ws-1', automationId: 'auto-1' }, AGENT_CALLER)
    assert.equal(errorCode(result), 'permission_escalation', JSON.stringify(config))
    assert.deepEqual(h.ran, [])
  }
})

test('automation.run: an agent on none cannot run an automation whose action it cannot bound', async () => {
  const h = harness('none', { automations: [storedAutomation('acme-deploy', {})] })
  const result = await h.call('automation.run', { workspaceId: 'ws-1', automationId: 'auto-1' }, AGENT_CALLER)
  assert.equal(errorCode(result), 'permission_escalation')
  assert.deepEqual(h.ran, [])
})

test('automation.run: an agent on none may run an automation that launches on none', async () => {
  const h = harness('none', { automations: [storedAutomation('spawn-agent', { permissionPreset: 'none' })] })
  const result = await h.call('automation.run', { workspaceId: 'ws-1', automationId: 'auto-1' }, AGENT_CALLER)
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
  assert.equal(h.ran.length, 1)
})

test('automation.run: an agent on bypass, or a caller with no agent identity, runs any automation', async () => {
  for (const [preset, context] of [
    ['bypass', AGENT_CALLER],
    ['none', EXTERNAL_CALLER],
  ] as const) {
    const h = harness(preset, { automations: [storedAutomation('acme-deploy', {})] })
    const result = await h.call('automation.run', { workspaceId: 'ws-1', automationId: 'auto-1' }, context)
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
    assert.equal(h.ran.length, 1)
  }
})

type ChatSession = { workspaceId: string; agentId: string; status: string; permissionPreset?: string }
type TerminalSession = {
  kind?: string
  workspaceId?: string
  agentId?: string
  processAlive: boolean
  agentRecord?: { cliPermissionPreset?: unknown }
}

function resolverOver(state: {
  chats?: ChatSession[]
  terminals?: TerminalSession[]
  records?: Record<string, unknown>
}): AgentPermissionResolver {
  return createAgentPermissionResolver({
    listConversationSessions: (agentId) => (state.chats ?? []).filter((session) => session.agentId === agentId),
    listTerminalSessions: () => state.terminals ?? [],
    readAgentRecordPreset: (workspaceId, agentId) => {
      const key = `${workspaceId}/${agentId}`
      return state.records && key in state.records ? { found: true, preset: state.records[key] } : { found: false }
    },
  })
}

test('resolver: a running chat answers with the preset it has now, not the one its record holds', () => {
  const resolve = resolverOver({
    chats: [{ workspaceId: 'ws-1', agentId: 'agent-a', status: 'ready', permissionPreset: 'none' }],
    records: { 'ws-1/agent-a': 'bypass' },
  })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-a' }), 'none')
})

test('resolver: a running chat that never chose a preset passes no override, so it reads as none', () => {
  const resolve = resolverOver({ chats: [{ workspaceId: 'ws-1', agentId: 'agent-a', status: 'active' }] })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-a' }), 'none')
})

test('resolver: a stopped chat is not the agent, so its record answers', () => {
  const resolve = resolverOver({
    chats: [{ workspaceId: 'ws-1', agentId: 'agent-a', status: 'stopped', permissionPreset: 'none' }],
    records: { 'ws-1/agent-a': 'bypass' },
  })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-a' }), 'bypass')
})

test('resolver: a live terminal main launched answers with its launch record', () => {
  const resolve = resolverOver({
    terminals: [
      {
        kind: 'agent',
        workspaceId: 'ws-1',
        agentId: 'agent-a',
        processAlive: true,
        agentRecord: { cliPermissionPreset: 'none' },
      },
    ],
    records: { 'ws-1/agent-a': 'bypass' },
  })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-a' }), 'none')
})

test("resolver: a window's terminal agent answers with its record, and an old record with none is bypass", () => {
  const resolve = resolverOver({ records: { 'ws-1/agent-a': 'none', 'ws-1/agent-b': undefined } })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-a' }), 'none')
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-b' }), 'bypass')
})

test('resolver: the strictest of several sessions under one id wins', () => {
  const resolve = resolverOver({
    chats: [
      { workspaceId: 'ws-1', agentId: 'agent-a', status: 'ready', permissionPreset: 'bypass' },
      { workspaceId: 'ws-1', agentId: 'agent-a', status: 'ready', permissionPreset: 'none' },
    ],
  })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-a' }), 'none')
})

test("resolver: another workspace's agent of the same id does not answer", () => {
  const resolve = resolverOver({
    chats: [{ workspaceId: 'ws-2', agentId: 'agent-a', status: 'ready', permissionPreset: 'bypass' }],
  })
  assert.equal(resolve({ workspaceId: 'ws-1', agentId: 'agent-a' }), null)
})

test('resolver: an agent nothing knows is unresolved', () => {
  assert.equal(resolverOver({})({ workspaceId: 'ws-1', agentId: 'agent-ghost' }), null)
  assert.equal(resolverOver({})({ agentId: 'agent-ghost' }), null)
})
