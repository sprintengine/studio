import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import {
  companionProviderIdFor,
  createCompanionAgentService,
  createCompanionAgentsModuleRegistry,
  type CompanionAgentService,
} from './companion-agent-service'
import { createMockConversationProvider } from './providers/mock-conversation-provider'
import type { ConversationEvent, ConversationStartSessionInput } from '../shared/conversation-runtime'
import type { CliPermissionPreset } from '../shared/cli-permission-preset'

// What a companion's structured run does with the approvals its agent raises.
// The mock provider ends every turn at an approval card, so each policy's
// answer (or its absence) is what the turn's end shows.

const SPEC = { workspaceId: 'workspace', agentId: 'guide', name: 'Guide', systemPrompt: '' }

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(): Promise<{
  runtime: ConversationRuntime
  service: CompanionAgentService
  workspaceRoot: string
  starts: ConversationStartSessionInput[]
}> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-tools-'))
  const runtime = new ConversationRuntime({
    adapters: [createMockConversationProvider()],
    getProviderById: () => undefined,
    secretStore: {
      getStatus: async () => ({ ok: false, message: 'unused' }),
      resolveSecret: async () => ({ ok: false, message: 'unused' }),
    },
  })
  const starts: ConversationStartSessionInput[] = []
  const service = createCompanionAgentService({
    runtime: {
      startSession: (input) => {
        starts.push(input)
        return runtime.startSession(input)
      },
      sendTurn: (input) => runtime.sendTurn(input),
      respondToRequest: (input) => runtime.respondToRequest(input),
      interrupt: (input) => runtime.interrupt(input),
      stopSession: (input) => runtime.stopSession(input),
      listSessions: (input) => runtime.listSessions(input),
      onEvent: (listener) => runtime.onEvent(listener),
    },
    resolveEngineDefaults: () => ({ providerId: 'mock-provider', modelId: 'mock-model' }),
  })
  cleanups.push(async () => {
    service.dispose()
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  })
  return { runtime, service, workspaceRoot, starts }
}

const notJson = () => ({ ok: false as const, errors: ['n/a'] })

test('a structured run denies every approval by default, and tells the agent it has no tools', async () => {
  const { service, workspaceRoot, starts } = await setup()
  const handle = service.attach({ ...SPEC, workspaceRoot })
  const events: ConversationEvent[] = []
  handle.onEvent((event) => events.push(event))

  // The mock fails a turn whose approval was denied.
  await assert.rejects(handle.runStructured({ prompt: 'Summarise.', validate: notJson }), /approval_denied/)
  const resolved = events.find((event) => event.type === 'approval_resolved')
  assert.equal(resolved?.payload?.approved, false, 'the approval was denied, not allowed')
  assert.equal(events.some((event) => event.type === 'turn_completed'), false)
  const said = events
    .filter((event) => event.type === 'content_delta')
    .map((event) => String(event.payload?.text))
    .join('')
  assert.match(said, /You have no tools for this task/, 'the agent heard it has no tools before the prompt')
  assert.match(said, /Summarise\./)
  // Every tool asks, so the policy is what answers.
  assert.equal(starts[0]?.permissionPreset, 'manual')
})

test('tools: auto allows every approval', async () => {
  const { service, workspaceRoot } = await setup()
  const handle = service.attach({ ...SPEC, workspaceRoot })
  const events: ConversationEvent[] = []
  handle.onEvent((event) => events.push(event))
  await assert.rejects(handle.runStructured({ prompt: 'Go.', tools: 'auto', retries: 0, validate: notJson }))
  assert.equal(events.find((event) => event.type === 'approval_resolved')?.payload?.approved, true)
  assert.ok(events.some((event) => event.type === 'turn_completed'))
  const said = events.filter((event) => event.type === 'content_delta').map((event) => String(event.payload?.text))
  assert.equal(said.join('').includes('You have no tools'), false)
})

test('tools: ask leaves the approval open until it is answered', async () => {
  const { service, workspaceRoot } = await setup()
  const handle = service.attach({ ...SPEC, workspaceRoot })
  const requested: string[] = []
  const events: ConversationEvent[] = []
  handle.onEvent((event) => {
    events.push(event)
    if (event.type === 'approval_requested') requested.push(String(event.payload?.requestId))
  })
  const run = handle.runStructured({ prompt: 'Go.', tools: 'ask', retries: 0, validate: notJson })
  const settled = run.then(
    () => 'resolved',
    () => 'rejected',
  )
  for (let waited = 0; requested.length === 0 && waited < 2000; waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  // Long enough for an answer the host made itself to have landed.
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(requested.length, 1)
  assert.equal(events.some((event) => event.type === 'approval_resolved'), false, 'nothing answered it')

  const unknown = await handle.respondToApproval({ requestId: 'nope', decision: 'once' })
  assert.equal(unknown.ok, false)
  const answered = await handle.respondToApproval({ requestId: requested[0]!, decision: 'once' })
  assert.deepEqual(answered, { ok: true })
  assert.equal(await settled, 'rejected', 'the turn completed, and the mock reply failed validation')
  assert.ok(events.some((event) => event.type === 'turn_completed'))
  const again = await handle.respondToApproval({ requestId: requested[0]!, decision: 'once' })
  assert.equal(again.ok, false, 'an answered request is no longer open')
})

test('a policy that is not one of the three is refused', async () => {
  const { service, workspaceRoot } = await setup()
  const handle = service.attach({ ...SPEC, workspaceRoot })
  await assert.rejects(
    handle.runStructured({ prompt: 'Go.', tools: 'everything' as never, validate: notJson }),
    /"tools" must be/,
  )
})

test('a module needs conversation:bypass for tools: auto, and conversation:operate to allow a tool call', async () => {
  const { service, workspaceRoot } = await setup()
  const permissions: Record<string, string[]> = {
    plain: ['agents:companion'],
    bypass: ['agents:companion', 'conversation:bypass'],
    operate: ['agents:companion', 'conversation:operate'],
  }
  let callerCeiling: CliPermissionPreset | null = null
  const registry = createCompanionAgentsModuleRegistry({
    service,
    getModulePermissions: (moduleId) => permissions[moduleId],
    getCallerPermissionCeiling: () => callerCeiling,
  })
  const spec = { ...SPEC, workspaceRoot }

  const plain = registry.attach('plain', spec)
  await assert.rejects(
    plain.runStructured({ prompt: 'Go.', tools: 'auto', validate: notJson }),
    /must declare the "conversation:bypass" permission/,
  )
  assert.equal(plain.status(), 'absent', 'a refused run starts nothing')
  const refusedAllow = await plain.respondToApproval({ requestId: 'r', decision: 'once' })
  assert.equal(refusedAllow.ok, false)
  assert.match(!refusedAllow.ok ? refusedAllow.message : '', /conversation:operate/)
  // Denying needs nothing more; there is just nothing open to deny.
  const deny = await plain.respondToApproval({ requestId: 'r', decision: 'deny' })
  assert.match(!deny.ok ? deny.message : '', /No approval request/)

  const operate = registry.attach('operate', spec)
  const nothingOpen = await operate.respondToApproval({ requestId: 'r', decision: 'once' })
  assert.match(!nothingOpen.ok ? nothingOpen.message : '', /No approval request/)

  const bypass = registry.attach('bypass', spec)
  callerCeiling = 'auto'
  await assert.rejects(
    bypass.runStructured({ prompt: 'Go.', tools: 'auto', validate: notJson }),
    /serves an agent's tool call/,
  )
  callerCeiling = null
  const events: string[] = []
  bypass.onEvent((event) => events.push(event.type))
  await assert.rejects(bypass.runStructured({ prompt: 'Go.', tools: 'auto', retries: 0, validate: notJson }))
  assert.ok(events.includes('turn_completed'), 'with conversation:bypass the run approved its way to the end')
  assert.equal(registry.attach('bypass', spec), bypass, 'the same companion is the same handle')
})

test('a companion engine takes a chat runtime id or a provider id', () => {
  assert.equal(companionProviderIdFor('claude-code'), 'claude-agent')
  assert.equal(companionProviderIdFor('codex'), 'codex-agent')
  assert.equal(companionProviderIdFor('claude-agent'), 'claude-agent')
  assert.equal(companionProviderIdFor('codex-agent'), 'codex-agent')
  assert.equal(companionProviderIdFor(undefined), 'claude-agent')
  assert.equal(companionProviderIdFor('  '), 'claude-agent')
})

test('the default engine runs a runtime id on its own provider and default model', async () => {
  const starts: ConversationStartSessionInput[] = []
  const service = createCompanionAgentService({
    runtime: {
      startSession: async (input) => {
        starts.push(input)
        return { ok: false, message: 'not started in this test' }
      },
      sendTurn: async () => ({ ok: false, message: 'unused' }),
      respondToRequest: async () => ({ ok: false, message: 'unused' }),
      interrupt: async () => ({ ok: false, message: 'unused' }),
      stopSession: async () => ({ ok: false, message: 'unused' }),
      listSessions: () => ({ ok: true, sessions: [] }),
      onEvent: () => () => undefined,
    },
  })
  const codex = service.attach({ ...SPEC, agentId: 'a', workspaceRoot: '/tmp/x', engine: { cli: 'codex' } })
  await assert.rejects(codex.runStructured({ prompt: 'Go.', validate: notJson }), /could not start/)
  const claude = service.attach({ ...SPEC, agentId: 'b', workspaceRoot: '/tmp/x', engine: { cli: 'claude-code' } })
  await assert.rejects(claude.runStructured({ prompt: 'Go.', validate: notJson }), /could not start/)
  assert.deepEqual(
    starts.map((input) => [input.providerId, input.modelId]),
    [
      ['codex-agent', 'default'],
      ['claude-agent', 'sonnet'],
    ],
  )
  service.dispose()
})
