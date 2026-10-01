import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import type { ConversationProviderAdapter, MockAdapterSessionInput } from './providers/conversation-provider-adapter'
import type { ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'

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

/**
 * A stateful CLI provider that takes skills as context, as Codex and the ACP
 * runtimes do, and records the text each turn hands it. `reverted` opens the
 * session as one whose files were put back, so the runtime carries its note.
 */
async function chat(options: { reverted?: boolean } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-commands-'))
  roots.add(workspaceRoot)
  const sent: string[] = []
  const sentSkills: Array<string[] | undefined> = []
  const adapter: ConversationProviderAdapter = {
    id: 'cli-agent',
    sessions: 'stateful',
    capabilities: {
      tools: true,
      approvals: true,
      questions: false,
      planMode: false,
      images: false,
      skills: 'context',
      reasoningEfforts: null,
      interrupt: true,
      resume: true,
      subagents: false,
      cost: false,
      contextMeter: false,
      liveModelSwitch: false,
    },
    listModels: () => ['model'],
    startSession: (input) => [
      event(input, 'session_started'),
      ...(options.reverted ? [event(input, 'session_updated', { revertedAfterSeq: 4 })] : []),
      event(input, 'session_ready'),
    ],
    async *sendTurn(input) {
      sent.push(input.message)
      sentSkills.push(input.skills)
      yield event(input, 'turn_started', { turnId: input.turnId })
      yield event(input, 'turn_completed', { turnId: input.turnId })
    },
    resolveApproval: () => [],
    interrupt: () => [],
    stopSession: () => [],
  }
  const runtime = new ConversationRuntime({
    adapters: [adapter],
    getProviderById: () => undefined,
    secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
    resolveSkills: async ({ skills }) =>
      skills.length
        ? { ids: skills.map((skill) => skill.id), context: 'Attached skill: tidy\nKeep it tidy.' }
        : { ids: [] },
  })
  runtimes.add(runtime)
  const recorded: Array<unknown> = []
  runtime.onEvent((event) => {
    if (event.type === 'user_message') recorded.push(event.payload?.skills)
  })
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'cli-agent',
    modelId: 'model',
  })
  if (!started.ok) throw new Error(started.message)
  const send = async (message: string, skills: string[] = []) => {
    const result = await runtime.sendTurn({
      sessionId: started.session.sessionId,
      message,
      skills: skills.map((id) => ({ id })),
    })
    expect(result.ok).toBe(true)
    return sent.at(-1)
  }
  return { send, sentSkills, recorded }
}

test('a message that opens with a slash command reaches the CLI with the command first and no skill text', async () => {
  const { send } = await chat()
  expect(await send('/review HEAD~1', ['tidy'])).toBe('/review HEAD~1')
})

test('an attached skill still leads a message that is not a command', async () => {
  const { send } = await chat()
  expect(await send('tidy the parser', ['tidy'])).toBe('Attached skill: tidy\nKeep it tidy.\n\ntidy the parser')
})

test('a message that opens with a path is prose, not a command', async () => {
  const { send } = await chat()
  expect(await send('/Users/dev/app fails to build', ['tidy'])).toMatch(/^Attached skill: tidy/)
})

test('the reverted-files note never precedes a command, and still goes with the next message', async () => {
  const { send } = await chat({ reverted: true })
  expect(await send('/compact')).toBe('/compact')
  expect(await send('carry on')).toMatch(/^Files were reverted to before conversation turn 4\..*\n\ncarry on$/s)
})

test('skills attached to a command wait for the next message that is not one, and go with it once', async () => {
  const { send, sentSkills, recorded } = await chat()
  expect(await send('/review HEAD~1', ['tidy'])).toBe('/review HEAD~1')
  expect(sentSkills.at(-1)).toEqual([])
  // The command's own message does not claim skills it went without.
  expect(recorded.at(-1)).toBeUndefined()
  // Another command does not use them up.
  expect(await send('/context')).toBe('/context')
  expect(await send('now fix what it found')).toBe('Attached skill: tidy\nKeep it tidy.\n\nnow fix what it found')
  expect(sentSkills.at(-1)).toEqual(['tidy'])
  expect(recorded.at(-1)).toEqual(['tidy'])
  expect(await send('and then carry on')).toBe('and then carry on')
})

test('a message about a top-level folder is prose while no command list is known', async () => {
  const { send } = await chat()
  expect(await send('/tmp is full', ['tidy'])).toMatch(/^Attached skill: tidy/)
})
