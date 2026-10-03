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

// The chat's permission mode on the app's side: what it answers when a request
// arrives, what a switch answers of the requests already waiting, and that a
// request the person answered is never answered again or relabelled.

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await tick()
  assert.ok(condition(), `timed out waiting for ${what}`)
}

/**
 * A stateful provider whose turn asks whatever the test raises and reports
 * each answer back through its stream, as a real provider does. It records
 * every answer it is given, and the presets it was switched to.
 */
function askingProvider() {
  let base: MockAdapterSessionInput | null = null
  const started: MockAdapterSessionInput[] = []
  let push: ((next: ConversationEvent) => void) | null = null
  let end: (() => void) | null = null
  let turnId = ''
  const answers: Array<{ requestId: string; approved: boolean }> = []
  const presets: ConversationPermissionPreset[] = []
  const adapter: ConversationProviderAdapter = {
    id: 'asking',
    sessions: 'stateful',
    listModels: () => ['model'],
    startSession: (input) => {
      base = input
      started.push(input)
      return [event(input, 'session_started'), event(input, 'session_ready')]
    },
    async *sendTurn(input) {
      turnId = input.turnId
      yield event(input, 'turn_started', { turnId })
      const buffered: ConversationEvent[] = []
      let wake: (() => void) | null = null
      let ended = false
      push = (next) => {
        buffered.push(next)
        wake?.()
      }
      end = () => {
        ended = true
        wake?.()
      }
      while (!ended || buffered.length) {
        if (!buffered.length) await new Promise<void>((resolve) => (wake = resolve))
        while (buffered.length) yield buffered.shift()!
      }
    },
    resolveApproval: (input) => {
      answers.push({ requestId: input.requestId, approved: input.approved })
      push?.(event(base!, 'approval_resolved', { turnId, requestId: input.requestId, approved: input.approved }))
      return []
    },
    interrupt: () => [],
    stopSession: () => [],
    async setPermissionPreset(input) {
      presets.push(input.permissionPreset)
      return { ok: true }
    },
  }
  const ask = (requestId: string, request: Record<string, unknown>) =>
    push!(event(base!, 'approval_requested', { turnId, requestId, kind: 'tool', ...request }))
  const finish = () => {
    push!(event(base!, 'turn_completed', { turnId }))
    end!()
  }
  return { adapter, answers, presets, started, ask, finish }
}

async function setup(
  permissionPreset: ConversationPermissionPreset,
  options: { platform?: NodeJS.Platform; hostId?: 'wsl:Ubuntu' } = {},
) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-modes-'))
  roots.add(workspaceRoot)
  const provider = askingProvider()
  if (options.hostId) provider.adapter.executionHostCli = 'asking'
  const runtime = new ConversationRuntime({
    adapters: [provider.adapter],
    getProviderById: () => undefined,
    secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
    ...(options.platform ? { platform: options.platform } : {}),
  })
  runtimes.add(runtime)
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'asking',
    modelId: 'model',
    permissionPreset,
    ...(options.hostId ? { cliRuntimes: { asking: { hostId: options.hostId } } } : {}),
  })
  assert.ok(started.ok)
  const sessionId = started.session.sessionId
  const events: ConversationEvent[] = []
  runtime.onEvent((next) => events.push(next))
  const sending = runtime.sendTurn({ sessionId, message: 'go' })
  await until(() => events.some((next) => next.type === 'turn_started'), 'the turn to start')
  const requested = (requestId: string) =>
    events.find((next) => next.type === 'approval_requested' && next.payload?.requestId === requestId)
  const resolved = (requestId: string) =>
    events.find((next) => next.type === 'approval_resolved' && next.payload?.requestId === requestId)
  const ask = async (requestId: string, request: Record<string, unknown>) => {
    provider.ask(requestId, request)
    await until(() => Boolean(requested(requestId)), `${requestId} to be asked`)
  }
  const done = async () => {
    provider.finish()
    await sending
  }
  return { runtime, provider, sessionId, workspaceRoot, events, requested, resolved, ask, done }
}

const bash = { action: 'Bash', toolKind: 'command', input: { command: 'npm test' } }
const editIn = (root: string) => ({ action: 'Edit', toolKind: 'file_edit', input: { file_path: `${root}/src/a.ts` } })

test('Auto answers an edit in the workspace as it arrives, and leaves a command to the person', async () => {
  const chat = await setup('auto')
  await chat.ask('edit', editIn(chat.workspaceRoot))
  await until(() => Boolean(chat.resolved('edit')), 'the edit to be answered')
  assert.deepEqual(chat.requested('edit')?.payload, {
    ...chat.requested('edit')?.payload,
    autoApproved: true,
    ruleLabel: 'Auto mode',
  })
  assert.equal(chat.resolved('edit')?.payload?.autoApproved, true)

  await chat.ask('bash', bash)
  await tick()
  assert.equal(chat.resolved('bash'), undefined, 'a command waits for the person')
  assert.deepEqual(chat.provider.answers, [{ requestId: 'edit', approved: true }])
  await chat.runtime.respondToRequest({ sessionId: chat.sessionId, requestId: 'bash', approved: false })
  await chat.done()
})

test('Bypass answers every tool request, and never a question or one the runtime says a person must answer', async () => {
  const chat = await setup('bypass')
  await chat.ask('bash', bash)
  await chat.ask('question', { action: 'AskUserQuestion', kind: 'question' })
  await chat.ask('safety', { ...bash, mustAsk: true })
  await until(() => Boolean(chat.resolved('bash')), 'the command to be answered')
  await tick()
  assert.deepEqual(chat.provider.answers, [{ requestId: 'bash', approved: true }])
  assert.equal(chat.requested('bash')?.payload?.ruleLabel, 'Bypass permissions mode')
  for (const requestId of ['question', 'safety'])
    await chat.runtime.respondToRequest({ sessionId: chat.sessionId, requestId, approved: false })
  await chat.done()
})

test('Manual and none answer nothing on their own', async () => {
  for (const preset of ['manual', 'none'] as const) {
    const chat = await setup(preset)
    await chat.ask('edit', editIn(chat.workspaceRoot))
    await tick()
    await tick()
    assert.deepEqual(chat.provider.answers, [], preset)
    assert.equal(chat.requested('edit')?.payload?.autoApproved, undefined, preset)
    await chat.runtime.respondToRequest({ sessionId: chat.sessionId, requestId: 'edit', approved: true })
    await chat.done()
  }
})

test('switching mode mid-turn answers the waiting requests the new mode covers, and only those', async () => {
  const chat = await setup('none')
  await chat.ask('edit', editIn(chat.workspaceRoot))
  await chat.ask('bash', bash)
  await chat.ask('outside', { action: 'Edit', toolKind: 'file_edit', input: { file_path: '/etc/hosts' } })

  const toAuto = await chat.runtime.setPermission({ sessionId: chat.sessionId, permissionPreset: 'auto' })
  assert.ok(toAuto.ok)
  await until(() => Boolean(chat.resolved('edit')), 'the edit to be answered')
  await tick()
  assert.deepEqual(chat.provider.answers, [{ requestId: 'edit', approved: true }])
  assert.equal(chat.resolved('edit')?.payload?.ruleLabel, 'Auto mode')

  const toBypass = await chat.runtime.setPermission({ sessionId: chat.sessionId, permissionPreset: 'bypass' })
  assert.ok(toBypass.ok)
  await until(() => chat.provider.answers.length === 3, 'the rest to be answered')
  assert.deepEqual(
    chat.provider.answers.map((answer) => answer.requestId).sort(),
    ['bash', 'edit', 'outside'],
    'each request is answered exactly once',
  )
  assert.deepEqual(chat.provider.presets, ['auto', 'bypass'])
  await chat.done()
})

test('a stricter mode chosen mid-turn answers and denies nothing that is waiting', async () => {
  const chat = await setup('auto')
  await chat.ask('bash', bash)
  assert.ok((await chat.runtime.setPermission({ sessionId: chat.sessionId, permissionPreset: 'manual' })).ok)
  await tick()
  assert.deepEqual(chat.provider.answers, [])
  // What arrives now is Manual's to ask about, even an edit Auto would have let through.
  await chat.ask('edit', editIn(chat.workspaceRoot))
  await tick()
  assert.deepEqual(chat.provider.answers, [])
  for (const requestId of ['bash', 'edit'])
    await chat.runtime.respondToRequest({ sessionId: chat.sessionId, requestId, approved: false })
  await chat.done()
})

test('Allow and switch: the answer the person gave stands, is not relabelled, and the switch answers the rest', async () => {
  const chat = await setup('none')
  await chat.ask('bash', bash)
  await chat.ask('other', { action: 'Bash', toolKind: 'command', input: { command: 'npm run build' } })

  // The card's "Allow and switch to Bypass": the answer first, then the mode.
  const allowed = await chat.runtime.respondToRequest({
    sessionId: chat.sessionId,
    requestId: 'bash',
    approved: true,
    decision: 'once',
  })
  assert.ok(allowed.ok)
  assert.ok((await chat.runtime.setPermission({ sessionId: chat.sessionId, permissionPreset: 'bypass' })).ok)
  await until(() => Boolean(chat.resolved('other')), 'the other request to be answered')
  assert.deepEqual(chat.provider.answers, [
    { requestId: 'bash', approved: true },
    { requestId: 'other', approved: true },
  ])
  assert.equal(chat.resolved('bash')?.payload?.autoApproved, undefined, "the person's answer reads as theirs")
  assert.equal(chat.resolved('other')?.payload?.ruleLabel, 'Bypass permissions mode')
  await chat.done()
})

test('a request answered once cannot be answered again while its resolution is on the way', async () => {
  const chat = await setup('none')
  await chat.ask('bash', bash)
  // Hold the provider's report of the answer, as a slow stream would.
  const answers = chat.provider.answers
  const resolveApproval = chat.provider.adapter.resolveApproval
  chat.provider.adapter.resolveApproval = (input) => {
    answers.push({ requestId: input.requestId, approved: input.approved })
    return []
  }
  assert.ok((await chat.runtime.respondToRequest({ sessionId: chat.sessionId, requestId: 'bash', approved: false })).ok)
  assert.deepEqual(
    await chat.runtime.respondToRequest({ sessionId: chat.sessionId, requestId: 'bash', approved: true }),
    { ok: false, message: 'This request has already been answered.' },
  )
  // A switch to a mode that would have allowed it leaves the person's deny alone.
  assert.ok((await chat.runtime.setPermission({ sessionId: chat.sessionId, permissionPreset: 'bypass' })).ok)
  await tick()
  assert.deepEqual(answers, [{ requestId: 'bash', approved: false }])
  chat.provider.adapter.resolveApproval = resolveApproval
  await chat.done()
})

test('an answer that names the kind it answers is refused for a request of another kind', async () => {
  const chat = await setup('none')
  await chat.ask('plan', { action: 'ExitPlanMode', kind: 'plan', plan: 'Rename the module.' })
  await chat.ask('bash', bash)
  const answer = (requestId: string, approved: boolean, requestKind?: 'tool' | 'question' | 'plan') =>
    chat.runtime.respondToRequest({
      sessionId: chat.sessionId,
      requestId,
      approved,
      ...(requestKind ? { requestKind } : {}),
    })
  // A tool permission's answer, or a question's, does not approve a plan.
  assert.deepEqual(await answer('plan', true, 'tool'), {
    ok: false,
    message: 'This request is a plan, not a tool permission.',
  })
  assert.deepEqual(await answer('plan', true, 'question'), {
    ok: false,
    message: 'This request is a plan, not a question.',
  })
  assert.deepEqual(await answer('bash', true, 'plan'), {
    ok: false,
    message: 'This request is a tool permission, not a plan.',
  })
  assert.deepEqual(chat.provider.answers, [], 'a refused answer reaches no provider')
  // The right kind is answered, and an answer that names none still answers any.
  assert.ok((await answer('plan', true, 'plan')).ok)
  assert.ok((await answer('bash', false)).ok)
  assert.deepEqual(chat.provider.answers, [
    { requestId: 'plan', approved: true },
    { requestId: 'bash', approved: false },
  ])
  await chat.done()
})

test('on a Linux server a stray WSL host id means nothing: the CLI runs here, and Auto still places the edit', async () => {
  // A WSL server is handed the runtimes a Windows front door built. Had the id
  // survived, the provider would look for wsl.exe, and the approval check
  // would respell /home/… into //wsl.localhost/…, outside the workspace.
  const chat = await setup('auto', { platform: 'linux', hostId: 'wsl:Ubuntu' })
  assert.equal(chat.provider.started[0]?.cliRuntimes?.asking?.hostId, undefined)
  await chat.ask('edit', editIn(chat.workspaceRoot))
  await until(() => Boolean(chat.resolved('edit')), 'the edit to be answered')
  assert.equal(chat.requested('edit')?.payload?.autoApproved, true)
  await chat.done()
})

test('on Windows a WSL host id is kept, and the approval check respells the agent’s Linux paths', async () => {
  const chat = await setup('auto', { platform: 'win32', hostId: 'wsl:Ubuntu' })
  assert.equal(chat.provider.started[0]?.cliRuntimes?.asking?.hostId, 'wsl:Ubuntu')
  await chat.ask('edit', editIn(chat.workspaceRoot))
  await tick()
  await tick()
  // The POSIX temp root is not a Windows spelling, so the respelled path
  // lands outside it: nothing answers on its own here.
  assert.equal(chat.requested('edit')?.payload?.autoApproved, undefined)
  await chat.runtime.respondToRequest({ sessionId: chat.sessionId, requestId: 'edit', approved: true })
  await chat.done()
})
