import assert from 'node:assert/strict'
import { test } from 'vitest'

import { getConversationService } from '../src/conversation.js'
import type { MainHost } from '../src/index.js'

// A host's raw registry as `conversation.module-service` serves it, recording
// every call with the module id the helper closed over.
function hostWith(registry: Record<string, (...args: unknown[]) => unknown>): MainHost {
  return {
    moduleId: 'acme',
    requireService: () => registry,
  } as unknown as MainHost
}

test('the helper forwards the new controls with the module’s id', async () => {
  const calls: unknown[][] = []
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return { ok: true }
    }
  const chats = getConversationService(
    hostWith({ setPermissionPreset: record('setPermissionPreset'), setModel: record('setModel') }),
  )
  const ref = { workspaceId: 'ws-1', agentId: 'agent-1' }
  await chats.setPermissionPreset(ref, 'auto')
  await chats.setModel(ref, 'default')
  assert.deepEqual(calls, [
    ['setPermissionPreset', 'acme', ref, 'auto'],
    ['setModel', 'acme', ref, 'default'],
  ])
})

test('a host from before conversation-controls answers a refusal, not a TypeError', async () => {
  const chats = getConversationService(hostWith({}))
  const ref = { workspaceId: 'ws-1', agentId: 'agent-1' }
  for (const answer of [await chats.setPermissionPreset(ref, 'manual'), await chats.setModel(ref, 'default')]) {
    assert.equal(answer.ok, false)
    if (answer.ok) continue
    assert.equal(answer.code, 'runtime_refused')
    assert.match(answer.message, /conversation-controls/)
  }
})

test('the helper forwards the protocol calls with the module’s id and every option', async () => {
  const calls: unknown[][] = []
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args])
      return name === 'follow' ? () => undefined : Promise.resolve({ ok: true })
    }
  const names = ['answerQuestion', 'resolvePlan', 'follow', 'interrupt', 'setPermissionPreset', 'setModel']
  const chats = getConversationService(hostWith(Object.fromEntries(names.map((name) => [name, record(name)]))))
  const ref = { workspaceId: 'ws-1', agentId: 'agent-1' }
  const onFrame = () => undefined
  await chats.answerQuestion(ref, { requestId: 'q', answers: { a: 'b' } })
  await chats.resolvePlan(ref, { requestId: 'p', decision: 'approve', commandId: 'c-1' })
  chats.follow(ref, { afterSeq: 3, generation: 'g' }, onFrame)
  await chats.interrupt(ref, { commandId: 'c-2' })
  await chats.setPermissionPreset(ref, 'auto', { permissionMode: 'acceptEdits', commandId: 'c-3' })
  await chats.setModel(ref, 'default', { commandId: 'c-4' })
  assert.deepEqual(calls, [
    ['answerQuestion', 'acme', ref, { requestId: 'q', answers: { a: 'b' } }],
    ['resolvePlan', 'acme', ref, { requestId: 'p', decision: 'approve', commandId: 'c-1' }],
    ['follow', 'acme', ref, { afterSeq: 3, generation: 'g' }, onFrame],
    ['interrupt', 'acme', ref, { commandId: 'c-2' }],
    ['setPermissionPreset', 'acme', ref, 'auto', { permissionMode: 'acceptEdits', commandId: 'c-3' }],
    ['setModel', 'acme', ref, 'default', { commandId: 'c-4' }],
  ])
})

test('a host from before the protocol calls answers as it can, and says which capability to check', async () => {
  const answered: unknown[] = []
  const chats = getConversationService(
    hostWith({
      respondToApproval: async (...args: unknown[]) => {
        answered.push(args)
        return { ok: true }
      },
    }),
  )
  const ref = { workspaceId: 'ws-1', agentId: 'agent-1' }
  // An older host took a question's answers on respondToApproval.
  assert.deepEqual(await chats.answerQuestion(ref, { requestId: 'q', answers: { a: 'b' } }), { ok: true })
  assert.deepEqual(answered, [['acme', ref, { requestId: 'q', approved: true, answers: { a: 'b' } }]])
  const plan = await chats.resolvePlan(ref, { requestId: 'p', decision: 'reject' })
  assert.equal(!plan.ok && plan.code, 'runtime_refused')
  assert.match(!plan.ok ? plan.message : '', /conversation-requests/)
  const frames: unknown[] = []
  const stop = chats.follow(ref, undefined, (frame) => frames.push(frame))
  assert.equal(typeof stop, 'function')
  assert.equal(frames.length, 1)
  assert.match((frames[0] as { message: string }).message, /conversation-streams/)
})
