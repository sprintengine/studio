import assert from 'node:assert/strict'
import { test } from 'vitest'

import { defaultAgent, type AgentState } from '../../shared/agent-state'
import type { ConversationEvent } from '../../shared/conversation-runtime'
import type { ConversationThread } from '../../shared/conversation-index'
import {
  createModuleActivityRegistry,
  type ModuleActivityRuntime,
  type ModuleActivityWorkspace,
} from './module-activity'

const T = Date.UTC(2026, 9, 8, 9)

function chat(id: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    ...defaultAgent(id, `Chat ${id}`),
    runtimeKind: 'conversation',
    conversation: { providerId: 'claude-agent', modelId: 'opus' },
    ...overrides,
  } as AgentState
}

function thread(agentId: string, createdAt: number, updatedAt: number): ConversationThread {
  return {
    agentId,
    title: `Thread ${agentId}`,
    titleSource: 'generated',
    createdAt,
    updatedAt,
    turnCount: 2,
    model: 'opus',
    providerId: 'claude-agent',
    lastSeq: 10,
    firstUserText: '',
  }
}

let seq = 0
function event(
  type: ConversationEvent['type'],
  createdAt: number,
  payload: Record<string, unknown>,
): ConversationEvent {
  seq += 1
  return {
    id: `e${seq}`,
    seq,
    sessionId: 's',
    workspaceId: 'ws-1',
    agentId: 'a1',
    providerId: 'claude-agent',
    modelId: 'opus',
    type,
    createdAt,
    payload,
  }
}

const transcript: ConversationEvent[] = [
  event('user_message', T - 60_000, { turnId: 't0', text: 'before the window' }),
  event('user_message', T + 1000, { turnId: 't1', text: 'Fix the flaky test' }),
  event('reasoning_delta', T + 1100, { turnId: 't1', text: 'thinking about secrets' }),
  event('tool_started', T + 1200, { turnId: 't1', tool: 'Bash', input: { command: 'cat .env' } }),
  event('tool_output', T + 1300, { turnId: 't1', output: 'API_KEY=hunter2' }),
  event('content_delta', T + 1400, { turnId: 't1', text: 'Fixed it: ' }),
  event('content_delta', T + 1500, { turnId: 't1', text: 'the retry now waits.' }),
  event('turn_completed', T + 1600, { turnId: 't1', costUsd: 0.1 }),
  // A message the app sent for the person is not theirs.
  event('user_message', T + 2000, {
    turnId: 't2',
    text: 'Agent finished',
    origin: { kind: 'studio', reason: 'agent-notice' },
  }),
  event('user_message', T + 3000, { turnId: 't3', text: 'Now ship it' }),
  event('content_delta', T + 3100, { turnId: 't3', text: 'partial' }),
  event('turn_completed', T + 3200, { turnId: 't3', text: 'Shipped as v2.' }),
]

function setup(permissions: readonly string[] = ['conversation:read-all']) {
  const workspaces: ModuleActivityWorkspace[] = [
    {
      id: 'ws-1',
      folderPath: '/Users/dev/acme',
      agents: {
        a1: chat('a1'),
        a2: chat('a2', { execution: { mode: 'worktree', worktreeId: 'w', cwd: '/Users/dev/acme-wt' } }),
        term: { ...defaultAgent('term'), runtimeKind: 'terminal' } as AgentState,
        fresh: chat('fresh'),
      },
    },
    {
      id: 'ws-2',
      folderPath: '/Users/dev/other',
      agents: {
        b1: chat('b1', { conversation: { providerId: 'codex-agent', modelId: 'gpt-5' } } as Partial<AgentState>),
      },
    },
  ]
  const reads: string[] = []
  const runtime: ModuleActivityRuntime = {
    async listThreads({ workspaceRoot, workspaceId }) {
      reads.push(`threads:${workspaceId}:${workspaceRoot}`)
      if (workspaceRoot === '/Users/dev/acme') return { ok: true, threads: [thread('a1', T - 86_400_000, T + 3200)] }
      if (workspaceRoot === '/Users/dev/acme-wt') return { ok: true, threads: [thread('a2', T - 10_000, T - 5000)] }
      if (workspaceRoot === '/Users/dev/other') return { ok: true, threads: [thread('b1', T + 10, T + 20)] }
      return { ok: true, threads: [] }
    },
    listSessions: ({ agentId } = {}) => ({
      ok: true,
      sessions:
        agentId === 'a1'
          ? [
              {
                sessionId: 's',
                workspaceId: 'ws-1',
                agentId: 'a1',
                providerId: 'claude-agent',
                modelId: 'opus-live',
                status: 'ready',
                createdAt: T,
                updatedAt: T,
              } as never,
            ]
          : [],
    }),
    async readTranscript(input) {
      reads.push(`transcript:${input.agentId}`)
      return input.agentId === 'a1' ? { ok: true, events: transcript } : { ok: true, events: [] }
    },
  }
  return {
    registry: createModuleActivityRegistry({
      getWorkspaces: () => workspaces,
      runtime,
      getModulePermissions: () => permissions,
    }),
    reads,
  }
}

test('conversation:read-all is required', async () => {
  const { registry, reads } = setup(['conversation:read'])
  const chats = await registry.listChats('insights')
  assert.equal(chats.ok ? null : chats.code, 'permission_missing')
  const prompts = await registry.prompts('insights', { from: T, to: T + 10_000 })
  assert.equal(prompts.ok ? null : prompts.code, 'permission_missing')
  assert.deepEqual(reads, [])
})

test('listChats summarises every chat with a transcript, newest first, filtered by window and workspace', async () => {
  const { registry } = setup()
  const all = await registry.listChats('insights')
  assert.ok(all.ok)
  if (!all.ok) return
  assert.deepEqual(
    all.chats.map((row) => [row.workspaceId, row.agentId, row.cli, row.status, row.model]),
    [
      ['ws-1', 'a1', 'claude-code', 'ready', 'opus-live'],
      ['ws-2', 'b1', 'codex', 'absent', 'gpt-5'],
      ['ws-1', 'a2', 'claude-code', 'absent', 'opus'],
    ],
  )
  assert.equal(all.chats[0]!.title, 'Thread a1')
  assert.equal(all.chats[0]!.turnCount, 2)

  const windowed = await registry.listChats('insights', { from: T, to: T + 100, workspaceId: 'ws-1' })
  assert.deepEqual(windowed.ok ? windowed.chats.map((row) => row.agentId) : null, ['a1'])
  const bad = await registry.listChats('insights', { from: 5, to: 1 })
  assert.equal(bad.ok ? null : bad.code, 'invalid_input')
})

test('prompts are the person own messages with the tail of each reply, and nothing of tools', async () => {
  const { registry, reads } = setup()
  const result = await registry.prompts('insights', { from: T, to: T + 10_000 })
  assert.ok(result.ok)
  if (!result.ok) return
  assert.deepEqual(result.prompts, [
    {
      at: T + 1000,
      workspaceId: 'ws-1',
      agentId: 'a1',
      text: 'Fix the flaky test',
      replyTail: 'Fixed it: the retry now waits.',
    },
    { at: T + 3000, workspaceId: 'ws-1', agentId: 'a1', text: 'Now ship it', replyTail: 'Shipped as v2.' },
  ])
  assert.equal(result.truncated, false)
  assert.doesNotMatch(JSON.stringify(result), /hunter2|cat \.env|thinking about secrets|Agent finished/)
  // a2 went idle before the window and was never read.
  assert.ok(!reads.includes('transcript:a2'))

  const limited = await registry.prompts('insights', { from: T, to: T + 10_000, limit: 1 })
  assert.deepEqual(limited.ok ? [limited.prompts.map((prompt) => prompt.text), limited.truncated] : null, [
    ['Now ship it'],
    true,
  ])
  const badLimit = await registry.prompts('insights', { from: T, to: T + 1, limit: 5000 })
  assert.equal(badLimit.ok ? null : badLimit.code, 'invalid_input')
})
