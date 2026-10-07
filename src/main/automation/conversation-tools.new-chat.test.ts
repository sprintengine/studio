import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationLaunchRequest, ConversationLaunchResult } from '../conversation-launch-service'
import { createConversationTools } from './conversation-tools'

// conversation.create never touches a chat's rest or visit clock.
const noLifecycle = {
  settle: () => assert.fail('conversation.create does not settle'),
  visit: () => assert.fail('conversation.create does not visit'),
}

// A phone's New chat: `worktree` and `effort` on conversation.create, checked
// here and handed to the launch, which cuts the worktree and judges the level.

const LAUNCHED: ConversationLaunchResult = {
  ok: true,
  workspaceId: 'ws-new',
  agentId: 'agent-claude-code-1',
  name: 'Ada',
  cli: 'claude-code',
  providerId: 'claude-agent',
  modelId: 'default',
  sessionId: 'conv_1',
}

function create() {
  const requests: ConversationLaunchRequest[] = []
  const [registration] = createConversationTools({
    launch: async (request) => {
      requests.push(request)
      return LAUNCHED
    },
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle: noLifecycle,
  })
  return { registration: registration!, requests }
}

function errorCode(result: { structuredContent?: unknown }): string | undefined {
  return (result.structuredContent as { error?: { code: string } }).error?.code
}

test('conversation.create declares worktree as a boolean and effort as a string', () => {
  const { registration } = create()
  const properties = (registration.inputSchema as { properties: Record<string, { type: string }> }).properties
  assert.equal(properties.worktree?.type, 'boolean')
  assert.equal(properties.effort?.type, 'string')
})

test('worktree with newChat reaches the launch as a new worktree', async () => {
  const { registration, requests } = create()
  const result = await registration.handler({ workspaceId: 'ws-1', newChat: true, worktree: true, prompt: 'hi' })
  assert.equal(result.isError, undefined)
  assert.deepEqual(requests, [{ workspaceId: 'ws-1', newChat: true, newWorktree: true, prompt: 'hi' }])
})

test('worktree false, or left out, asks for no worktree', async () => {
  const { registration, requests } = create()
  await registration.handler({ workspaceId: 'ws-1', newChat: true, worktree: false })
  await registration.handler({ workspaceId: 'ws-1', newChat: true })
  assert.deepEqual(requests, [
    { workspaceId: 'ws-1', newChat: true },
    { workspaceId: 'ws-1', newChat: true },
  ])
})

test('worktree without newChat is refused before anything is launched', async () => {
  const { registration, requests } = create()
  const result = await registration.handler({ workspaceId: 'ws-1', worktree: true })
  assert.equal(errorCode(result), 'invalid_arguments')
  assert.equal(requests.length, 0)
})

test('a worktree that is not a boolean is refused', async () => {
  const { registration, requests } = create()
  const result = await registration.handler({ workspaceId: 'ws-1', newChat: true, worktree: 'yes' })
  assert.equal(errorCode(result), 'invalid_arguments')
  assert.equal(requests.length, 0)
})

test('effort reaches the launch as the reasoning effort, trimmed', async () => {
  const { registration, requests } = create()
  await registration.handler({ workspaceId: 'ws-1', cli: 'claude-code', effort: ' high ' })
  assert.deepEqual(requests, [{ workspaceId: 'ws-1', cli: 'claude-code', reasoningEffort: 'high' }])
})

test('an effort that is not a string is refused', async () => {
  const { registration, requests } = create()
  const result = await registration.handler({ workspaceId: 'ws-1', effort: 3 })
  assert.equal(errorCode(result), 'invalid_arguments')
  assert.equal(requests.length, 0)
})

test('an effort that is not shaped like a level id is refused', async () => {
  const { registration, requests } = create()
  const result = await registration.handler({ workspaceId: 'ws-1', effort: 'very high please' })
  assert.equal(errorCode(result), 'invalid_arguments')
  assert.equal(requests.length, 0)
})

async function refusedWith(code: string) {
  const [registration] = createConversationTools({
    launch: async () => ({ ok: false, code, message: 'refused' }),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle: noLifecycle,
  })
  return registration!.handler({ workspaceId: 'ws-1', newChat: true, worktree: true, effort: 'max' })
}

test("the launch's refusal of a worktree is passed through under its own code", async () => {
  const result = await refusedWith('worktree_unavailable')
  assert.equal(result.isError, true)
  assert.equal(errorCode(result), 'worktree_unavailable')
})

test("the launch's refusal of an effort level is passed through under its own code", async () => {
  const result = await refusedWith('unsupported_effort')
  assert.equal(result.isError, true)
  assert.equal(errorCode(result), 'unsupported_effort')
})

test('a chat whose worktree is still installing says so, with no path on this machine in the answer', async () => {
  const [registration] = createConversationTools({
    launch: async () => ({
      ...(LAUNCHED as Extract<ConversationLaunchResult, { ok: true }>),
      dependencyInstall: {
        id: 'install-1',
        repoRoot: '/Users/dev/app',
        path: '/Users/dev/.sprintengine-worktrees/app/chat-k7qz',
        branch: 'agent/chat-k7qz',
        command: 'npm ci',
        reason: 'changed',
        state: 'running',
        startedAt: 10,
        endedAt: null,
        lastLine: 'added 12 packages',
        output: null,
        exitCode: null,
      },
    }),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle: noLifecycle,
  })
  const result = await registration!.handler({ workspaceId: 'ws-1', newChat: true, worktree: true, prompt: 'hi' })
  const answer = result.structuredContent as { conversation: { sessionId: string }; dependencyInstall: unknown }
  assert.equal(answer.conversation.sessionId, 'conv_1', 'the conversation member is unchanged')
  assert.deepEqual(answer.dependencyInstall, {
    state: 'running',
    command: 'npm ci',
    reason: 'changed',
    startedAt: 10,
    endedAt: null,
    lastLine: 'added 12 packages',
    exitCode: null,
  })
  assert.doesNotMatch(JSON.stringify(answer), /\/Users\/dev/u)
})

test('a chat with nothing installing answers as it always did', async () => {
  const { registration } = create()
  const result = await registration.handler({ workspaceId: 'ws-1', newChat: true, worktree: true, prompt: 'hi' })
  assert.equal('dependencyInstall' in (result.structuredContent as object), false)
})
