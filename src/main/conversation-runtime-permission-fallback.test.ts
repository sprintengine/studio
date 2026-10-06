import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import type { ConversationProviderAdapter, MockAdapterSessionInput } from './providers/conversation-provider-adapter'
import type {
  ConversationEvent,
  ConversationEventType,
  ConversationPermissionPreset,
} from '../shared/conversation-runtime'

// A runtime that will not start under the chat's permission mode is started
// again with no permission setting, and the chat says so. A failure that is
// not the setting's fails as it did.

const runtimes = new Set<ConversationRuntime>()
const roots = new Set<string>()

afterEach(async () => {
  await Promise.all(Array.from(runtimes, (runtime) => runtime.shutdown().catch(() => undefined)))
  runtimes.clear()
  await Promise.all(Array.from(roots, (root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

function event(input: MockAdapterSessionInput, type: ConversationEventType, payload?: object): ConversationEvent {
  return {
    id: '',
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    providerId: input.providerId,
    modelId: input.modelId,
    type,
    createdAt: 0,
    payload: payload as ConversationEvent['payload'],
  }
}

type Refuses = { start?: 'flag' | 'always'; turn?: 'flag' | 'always' | 'after-output' | 'refused-here' }

/**
 * A provider that refuses to start (its session, or a turn's child) under any
 * mode but `none` ('flag'), under every mode ('always'), fails a turn only
 * after it has replied ('after-output'), or turns the message away itself,
 * before any CLI is asked, under any mode but `none` ('refused-here').
 */
function refusingProvider(refuses: Refuses, hooks: { beforeTurnFails?: () => Promise<void> } = {}) {
  let preset: ConversationPermissionPreset = 'none'
  const presets: ConversationPermissionPreset[] = []
  const starts: Array<ConversationPermissionPreset | undefined> = []
  const turns: Array<ConversationPermissionPreset | undefined> = []
  const refused = (mode: Refuses['turn'], under: ConversationPermissionPreset) =>
    mode === 'always' || (mode === 'flag' && under !== 'none')
  const adapter: ConversationProviderAdapter = {
    id: 'refusing',
    displayName: 'Refusing CLI',
    sessions: 'stateful',
    listModels: () => ['model'],
    startSession: (input) => {
      starts.push(input.permissionPreset)
      preset = input.permissionPreset ?? 'none'
      if (refused(refuses.start, preset)) throw new Error("error: unknown option '--permission-mode'")
      return [event(input, 'session_started'), event(input, 'session_ready')]
    },
    async *sendTurn(input) {
      turns.push(input.permissionPreset)
      yield event(input, 'turn_started', { turnId: input.turnId })
      if (refuses.turn === 'after-output') {
        yield event(input, 'content_delta', { turnId: input.turnId, text: 'half a reply' })
        yield event(input, 'turn_failed', { turnId: input.turnId, reason: 'provider', message: 'lost the network' })
        return
      }
      if (refuses.turn === 'refused-here' && preset !== 'none') {
        yield event(input, 'turn_failed', {
          turnId: input.turnId,
          message: "/always-approve would change Refusing CLI's permissions from inside the conversation.",
          refused: true,
        })
        return
      }
      if (refused(refuses.turn, preset)) {
        await hooks.beforeTurnFails?.()
        yield event(input, 'turn_failed', {
          turnId: input.turnId,
          reason: 'provider',
          message: "error: option '--permission-mode <mode>' argument 'acceptEdits' is invalid",
        })
        return
      }
      yield event(input, 'content_delta', { turnId: input.turnId, text: 'hello' })
      yield event(input, 'turn_completed', { turnId: input.turnId })
    },
    resolveApproval: () => [],
    interrupt: () => [],
    stopSession: () => [],
    async setPermissionPreset(input) {
      presets.push(input.permissionPreset)
      preset = input.permissionPreset
      return { ok: true }
    },
  }
  return { adapter, presets, starts, turns }
}

async function start(
  refuses: Refuses,
  permissionPreset: ConversationPermissionPreset,
  hooks?: Parameters<typeof refusingProvider>[1],
) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-permission-fallback-'))
  roots.add(workspaceRoot)
  const provider = refusingProvider(refuses, hooks)
  const runtime = new ConversationRuntime({
    adapters: [provider.adapter],
    getProviderById: () => undefined,
    secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
  })
  runtimes.add(runtime)
  const events: ConversationEvent[] = []
  runtime.onEvent((next) => events.push(next))
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'refusing',
    modelId: 'model',
    permissionPreset,
  })
  return { runtime, provider, events, started }
}

const notices = (events: ConversationEvent[]) =>
  events.filter((next) => next.type === 'session_updated' && typeof next.payload?.notice === 'string')

test('a turn whose child will not start under the mode is sent again with no flag, and the chat says so', async () => {
  const chat = await start({ turn: 'flag' }, 'manual')
  assert.ok(chat.started.ok)
  const sent = await chat.runtime.sendTurn({ sessionId: chat.started.session.sessionId, message: 'go' })

  assert.ok(sent.ok)
  assert.equal(sent.session.permissionPreset, 'none')
  assert.deepEqual(chat.provider.turns, ['manual', 'none'])
  assert.deepEqual(chat.provider.presets, ['none'])
  assert.equal(
    chat.events.some((next) => next.type === 'turn_failed'),
    false,
    'the failed attempt is not in the chat',
  )
  assert.equal(chat.events.filter((next) => next.type === 'turn_started').length, 1)
  assert.equal(chat.events.filter((next) => next.type === 'content_delta').length, 1)
  const [notice] = notices(chat.events)
  assert.equal(notice?.payload?.permissionPreset, 'none')
  assert.match(String(notice?.payload?.notice), /^Refusing CLI would not start with Manual, so this chat runs with no/)
  assert.match(String(notice?.payload?.notice), /argument 'acceptEdits' is invalid/)
})

test('a turn that fails with no flag as well keeps its mode and reports the first failure', async () => {
  const chat = await start({ turn: 'always' }, 'auto')
  assert.ok(chat.started.ok)
  const sent = await chat.runtime.sendTurn({ sessionId: chat.started.session.sessionId, message: 'go' })

  assert.ok(sent.ok)
  assert.equal(sent.session.permissionPreset, 'auto')
  assert.deepEqual(chat.provider.presets, ['none', 'auto'])
  const failures = chat.events.filter((next) => next.type === 'turn_failed')
  assert.equal(failures.length, 1)
  assert.match(String(failures[0]?.payload?.message), /acceptEdits/)
  assert.deepEqual(notices(chat.events), [])
})

test('a turn that fails after it has started is not sent again', async () => {
  const chat = await start({ turn: 'after-output' }, 'bypass')
  assert.ok(chat.started.ok)
  await chat.runtime.sendTurn({ sessionId: chat.started.session.sessionId, message: 'go' })

  assert.deepEqual(chat.provider.turns, ['bypass'])
  assert.deepEqual(chat.provider.presets, [])
  assert.equal(chat.events.filter((next) => next.type === 'turn_failed').length, 1)
})

test('a message the runtime turned away itself is not sent again with no flag', async () => {
  // Sent again under No flag, a command refused for loosening the mode would
  // go through: the guard depends on the mode the retry drops.
  const chat = await start({ turn: 'refused-here' }, 'manual')
  assert.ok(chat.started.ok)
  const sent = await chat.runtime.sendTurn({ sessionId: chat.started.session.sessionId, message: '/always-approve' })

  assert.ok(sent.ok)
  assert.equal(sent.session.permissionPreset, 'manual')
  assert.deepEqual(chat.provider.turns, ['manual'])
  assert.deepEqual(chat.provider.presets, [])
  const failures = chat.events.filter((next) => next.type === 'turn_failed')
  assert.equal(failures.length, 1)
  assert.match(String(failures[0]?.payload?.message), /would change/)
  assert.deepEqual(notices(chat.events), [])
})

test('a mode picked while the turn was starting is kept when that turn fails', async () => {
  let chat: Awaited<ReturnType<typeof start>> | null = null
  let picked: Promise<unknown> | null = null
  chat = await start({ turn: 'always' }, 'bypass', {
    // The person switches to Manual during a slow first start, before it fails.
    beforeTurnFails: async () => {
      if (!chat?.started.ok || picked) return
      picked = chat.runtime.setPermission({ sessionId: chat.started.session.sessionId, permissionPreset: 'manual' })
      await picked
    },
  })
  assert.ok(chat.started.ok)
  const sent = await chat.runtime.sendTurn({ sessionId: chat.started.session.sessionId, message: 'go' })

  assert.ok(sent.ok)
  assert.equal(sent.session.permissionPreset, 'manual', 'not put back to Bypass, nor dropped to No flag')
  assert.deepEqual(chat.provider.presets, ['manual'])
  assert.deepEqual(chat.provider.turns, ['bypass'])
})

test('a chat on no flag that fails is not sent again', async () => {
  const chat = await start({ turn: 'always' }, 'none')
  assert.ok(chat.started.ok)
  await chat.runtime.sendTurn({ sessionId: chat.started.session.sessionId, message: 'go' })

  assert.deepEqual(chat.provider.turns, ['none'])
  assert.deepEqual(chat.provider.presets, [])
})

test('a session that will not start under the mode starts with no flag, and the chat says so', async () => {
  const chat = await start({ start: 'flag' }, 'auto')

  assert.ok(chat.started.ok)
  assert.equal(chat.started.session.permissionPreset, 'none')
  assert.deepEqual(chat.provider.starts, ['auto', 'none'])
  const [notice] = notices(chat.events)
  assert.equal(notice?.payload?.permissionPreset, 'none')
  assert.match(String(notice?.payload?.notice), /^Refusing CLI would not start with Auto/)
  assert.match(String(notice?.payload?.notice), /unknown option '--permission-mode'/)
})

test('a session that will not start with no flag either reports the first failure', async () => {
  const chat = await start({ start: 'always' }, 'bypass')

  assert.equal(chat.started.ok, false)
  assert.match(chat.started.ok ? '' : chat.started.message, /unknown option/)
  assert.deepEqual(chat.provider.starts, ['bypass', 'none'])
  assert.deepEqual(notices(chat.events), [])
})
