import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { ConversationEvent } from '../shared/conversation-runtime'
import {
  captureConversationPullRequests,
  isPullRequestCreation,
  pullRequestUrlIn,
} from './conversation-pull-request-capture'

function harness() {
  let listener: ((event: ConversationEvent) => void) | null = null
  const captured: { url: string; workspaceId: string }[] = []
  const stop = captureConversationPullRequests({
    onEvent: (next) => {
      listener = next
      return () => {
        listener = null
      }
    },
    noteCaptured: (input) => captured.push(input),
  })
  let seq = 0
  const emit = (
    type: ConversationEvent['type'],
    payload: Record<string, unknown>,
    over: Partial<ConversationEvent> = {},
  ) =>
    listener?.({
      id: `e${++seq}`,
      sessionId: 'chat-session',
      workspaceId: 'chat-1',
      agentId: 'agent',
      providerId: 'claude',
      modelId: 'opus',
      type,
      createdAt: seq,
      payload,
      ...over,
    })
  return { captured, emit, stop }
}

const URL = 'https://github.com/acme/app/pull/138'

test('a chat agent running gh pr create files the pull request against its conversation', () => {
  const { captured, emit } = harness()
  emit('tool_started', {
    toolUseId: 't1',
    name: 'Bash',
    input: { command: 'git push -u origin HEAD && gh pr create --fill' },
  })
  emit('tool_output', { toolUseId: 't1', output: `Creating pull request for agent/fold-tool-calls\n\n${URL}\n` })
  assert.deepEqual(captured, [{ url: URL, workspaceId: 'chat-1' }])
})

test('the URL comes from the output only, and only for gh pr create', () => {
  const { captured, emit } = harness()
  // gh pr list / view print other pull requests' URLs.
  emit('tool_started', { toolUseId: 't1', name: 'Bash', input: { command: 'gh pr list --state all' } })
  emit('tool_output', { toolUseId: 't1', output: URL })
  emit('tool_started', { toolUseId: 't2', name: 'Bash', input: { command: 'gh pr view 138' } })
  emit('tool_output', { toolUseId: 't2', output: URL })
  // A creation whose output names no pull request (it failed before GitHub answered).
  emit('tool_started', { toolUseId: 't3', name: 'Bash', input: { command: 'gh pr create --fill' } })
  emit('tool_output', { toolUseId: 't3', output: 'could not find any commits between origin/main and HEAD' })
  // An output for a call this never saw start.
  emit('tool_output', { toolUseId: 't9', output: URL })
  assert.deepEqual(captured, [])
})

test('a streamed preview waits for the final output; a failed creation still counts', () => {
  const { captured, emit } = harness()
  emit('tool_started', { toolUseId: 't1', name: 'Bash', input: { command: 'gh pr create --fill' } })
  emit('tool_output', { toolUseId: 't1', partial: true, output: 'pushing…' })
  assert.deepEqual(captured, [])
  // `gh pr create` exits non-zero when the branch already has one, and names it.
  emit('tool_output', {
    toolUseId: 't1',
    status: 'error',
    output: `a pull request for branch "agent/x" into branch "main" already exists:\n${URL}`,
  })
  assert.deepEqual(captured, [{ url: URL, workspaceId: 'chat-1' }])
})

test('the same tool call id in another session is a different call', () => {
  const { captured, emit } = harness()
  emit('tool_started', { toolUseId: 't1', input: { command: 'gh pr create' } })
  emit('tool_output', { toolUseId: 't1', output: URL }, { sessionId: 'someone-else' })
  assert.deepEqual(captured, [])
})

test('unsubscribing stops the capture', () => {
  const { captured, emit, stop } = harness()
  stop()
  emit('tool_started', { toolUseId: 't1', input: { command: 'gh pr create' } })
  emit('tool_output', { toolUseId: 't1', output: URL })
  assert.deepEqual(captured, [])
})

test('the gate reads every command spelling the providers use', () => {
  assert.equal(isPullRequestCreation({ command: '/opt/homebrew/bin/gh pr  create -t x' }), true)
  assert.equal(isPullRequestCreation({ command: ['bash', '-lc', 'gh pr create --fill'] }), true, "Codex's argv")
  assert.equal(isPullRequestCreation({ cmd: 'cd ../website && gh pr create' }), true)
  assert.equal(isPullRequestCreation({ command: 'gh pr checks' }), false)
  assert.equal(isPullRequestCreation('gh pr create'), false, 'an input is an object, never a bare string')
  assert.equal(isPullRequestCreation(null), false)
})

test('the URL is found wherever an output hides it, and only a real pull request URL', () => {
  assert.equal(pullRequestUrlIn({ content: [{ type: 'text', text: `done: ${URL}` }] }), URL)
  assert.equal(pullRequestUrlIn({ stderr: URL }), URL)
  assert.equal(pullRequestUrlIn('https://github.com/acme/app/pull/new/agent/x'), null, 'the "create one" link')
  assert.equal(pullRequestUrlIn('https://github.com/acme/app/issues/7'), null)
  assert.equal(pullRequestUrlIn('https://bitbucket.org/a/b/pull/3'), null)
})
