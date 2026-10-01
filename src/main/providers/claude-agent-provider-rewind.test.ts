import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

type Child = { options: Record<string, unknown>; prompts: unknown[]; emit: (message: Record<string, unknown>) => void }

/** A stand-in SDK where each spawned child has its own script, ended when the adapter aborts it. */
function harness() {
  const children: Child[] = []
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    let ended = false
    const child: Child = {
      options: params.options,
      prompts: [],
      emit: (message) => {
        pending.push(message)
        wake?.()
      },
    }
    children.push(child)
    const stop = () => {
      ended = true
      wake?.()
    }
    ;(params.options.abortController as AbortController | undefined)?.signal.addEventListener('abort', stop)
    void (async () => {
      for await (const message of params.prompt) child.prompts.push(message)
    })()
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      interrupt: async () => stop(),
      setPermissionMode: async () => undefined,
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
  })
  const turn = (turnId: string, overrides: Partial<MockAdapterTurnInput> = {}): MockAdapterTurnInput => ({
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    workspaceRoot: '/Users/dev/app',
    turnId,
    requestId: `approval_${turnId}`,
    message: 'hello',
    ...overrides,
  })
  // Send a turn, wait for the child to read it, play `script`, and collect the turn's events.
  const run = async (turnId: string, script: (child: Child) => void): Promise<ConversationEvent[]> => {
    const count = children.reduce((sum, child) => sum + child.prompts.length, 0)
    const stream = (await adapter.sendTurn(turn(turnId))) as AsyncIterable<ConversationEvent>
    const events: ConversationEvent[] = []
    const done = (async () => {
      for await (const event of stream) events.push(event)
    })()
    for (let attempt = 0; attempt < 2000; attempt++) {
      if (children.reduce((sum, child) => sum + child.prompts.length, 0) > count) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    script(children.at(-1)!)
    await done
    return events
  }
  return { adapter, children, turn, run }
}

const assistant = (uuid: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid,
  parent_tool_use_id: null,
  message: { content: [{ type: 'text', text: 'done' }] },
  ...extra,
})
const result = (sessionId: string) => ({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId })

test('a Claude turn ends carrying the newest entry of its main chain, not a subagent one', async () => {
  const h = harness()
  try {
    await h.adapter.startSession(h.turn('turn_1'))
    const events = await h.run('turn_1', (child) => {
      child.emit({ type: 'system', subtype: 'init', session_id: 'native-1' })
      child.emit(assistant('entry-1', { session_id: 'native-1' }))
      child.emit(assistant('sub-entry', { session_id: 'native-1', parent_tool_use_id: 'task-1' }))
      child.emit(result('native-1'))
    })
    const end = events.find((event) => event.type === 'turn_completed')
    assert.deepEqual(end?.payload?.providerCursor, { sessionId: 'native-1', at: 'entry-1' })
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a Claude rewind drops the child and the next one forks the session at the kept turn', async () => {
  const h = harness()
  try {
    await h.adapter.startSession(h.turn('turn_1'))
    await h.run('turn_1', (child) => {
      child.emit(assistant('entry-1', { session_id: 'native-1' }))
      child.emit(result('native-1'))
    })
    await h.run('turn_2', (child) => {
      child.emit(assistant('entry-2', { session_id: 'native-1' }))
      child.emit(result('native-1'))
    })
    assert.deepEqual(await h.adapter.rewind({ ...h.turn('x'), cursor: { sessionId: 'native-1', at: 'entry-1' } }), {
      ok: true,
    })
    assert.equal(h.adapter.listLiveSessions()[0]?.hasChildProcess, false)
    const events = await h.run('turn_3', (child) => {
      // The fork reports a session of its own.
      child.emit({ type: 'system', subtype: 'init', session_id: 'native-2' })
      child.emit(result('native-2'))
    })
    assert.equal(h.children.length, 2)
    assert.equal(h.children[1].options.resume, 'native-1')
    assert.equal(h.children[1].options.resumeSessionAt, 'entry-1')
    assert.equal(h.children[1].options.forkSession, true)
    assert.ok(
      events.some((event) => event.type === 'session_updated' && event.payload?.providerSessionId === 'native-2'),
    )
    // Once a child has started from the fork point, the next one resumes the fork whole.
    h.adapter.disposeChildProcess('conv_1')
    await h.run('turn_4', (child) => child.emit(result('native-2')))
    assert.equal(h.children[2].options.resume, 'native-2')
    assert.equal(h.children[2].options.resumeSessionAt, undefined)
    assert.equal(h.children[2].options.forkSession, undefined)
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a Claude rewind past the first turn starts a new session, and is refused mid-turn', async () => {
  const h = harness()
  try {
    await h.adapter.startSession(h.turn('turn_1'))
    await h.run('turn_1', (child) => {
      child.emit(assistant('entry-1', { session_id: 'native-1' }))
      child.emit(result('native-1'))
    })
    assert.deepEqual(await h.adapter.rewind({ ...h.turn('x'), cursor: null }), { ok: true })
    await h.run('turn_2', (child) => {
      assert.equal(child.options.resume, undefined)
      child.emit(result('native-3'))
    })
    assert.equal(h.children.length, 2)
    let refused: Awaited<ReturnType<typeof h.adapter.rewind>> | undefined
    await h.run('turn_3', () => {
      void h.adapter.rewind({ ...h.turn('x'), cursor: null }).then((answer) => {
        refused = answer
        h.children[1].emit(result('native-3'))
      })
    })
    assert.deepEqual(refused, { ok: false, message: 'Stop the running turn before editing an earlier message.' })
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a Claude session restarted after a rewind forks once and records that it has', async () => {
  const h = harness()
  try {
    const started = (await h.adapter.startSession({
      ...h.turn('turn_1'),
      resumeSessionId: 'native-1',
      resumeSessionAt: 'entry-1',
    })) as ConversationEvent[]
    // Until a child starts from the point, the session's own cursor keeps it.
    assert.equal(started[0].payload?.providerResumeAt, 'entry-1')
    const events = await h.run('turn_1', (child) => {
      // An init that keeps the session's id still moves the cursor past the rewind.
      child.emit({ type: 'system', subtype: 'init', session_id: 'native-1' })
      child.emit(result('native-1'))
    })
    assert.equal(h.children[0].options.resumeSessionAt, 'entry-1')
    const cursor = events.find((event) => event.type === 'session_updated')
    assert.deepEqual(cursor?.payload, { providerSessionId: 'native-1' })
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a Claude fork whose point is gone fails the turn plainly and leaves the session resumable', async () => {
  const h = harness()
  try {
    await h.adapter.startSession(h.turn('turn_1'))
    await h.run('turn_1', (child) => {
      child.emit({ type: 'system', subtype: 'init', session_id: 'native-1' })
      child.emit(assistant('entry-1', { session_id: 'native-1' }))
      child.emit(result('native-1'))
    })
    assert.ok((await h.adapter.rewind({ ...h.turn('x'), cursor: { sessionId: 'native-1', at: 'gone' } })).ok)
    const events = await h.run('turn_2', (child) => {
      // The CLI refuses before it starts, under a session id nothing was
      // written to.
      child.emit({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: 'unwritten-9',
        errors: ['No message found with message.uuid of: gone'],
      })
    })
    const failed = events.find((event) => event.type === 'turn_failed')
    assert.match(String(failed?.payload?.message), /could not go back to that earlier message/)
    assert.equal(failed?.payload?.providerCursor, undefined, 'the missing point is no point to go back to')
    const cursors = events.filter((event) => event.type === 'session_updated').map((event) => event.payload)
    // The cursor the rewind recorded is replaced by the session as it was.
    assert.deepEqual(cursors, [{ providerSessionId: 'native-1' }])
    assert.equal(h.adapter.listLiveSessions()[0]?.providerSessionId, 'native-1')
    assert.equal(h.adapter.listLiveSessions()[0]?.hasChildProcess, false)
    await h.run('turn_3', (child) => child.emit(result('native-1')))
    assert.equal(h.children[2].options.resume, 'native-1')
    assert.equal(h.children[2].options.resumeSessionAt, undefined)
    assert.equal(h.children[2].options.forkSession, undefined)
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a Claude fork branches the parent’s session at the recorded entry, and only there', async () => {
  const h = harness()
  try {
    const parent = { ...h.turn('x'), resumeSessionId: 'native-1', latest: false }
    assert.deepEqual(
      await h.adapter.fork({ ...parent, cursor: { sessionId: 'native-1', at: 'entry-1' }, exact: true }),
      { ok: true, cursor: { sessionId: 'native-1', at: 'entry-1' } },
    )
    // Before the first message there is nothing to branch.
    assert.deepEqual(await h.adapter.fork({ ...parent, cursor: null, exact: true }), { ok: true, cursor: null })
    // A Claude chat takes no conversation as text, so a point it never
    // recorded is refused rather than guessed.
    assert.equal((await h.adapter.fork({ ...parent, cursor: null, exact: false })).ok, false)

    // The fork's own session: its first child resumes the parent's session up
    // to the entry, as a fork, and from then on follows the session it made.
    await h.adapter.startSession({ ...h.turn('turn_1'), resumeSessionId: 'native-1', resumeSessionAt: 'entry-1' })
    const events = await h.run('turn_1', (child) => {
      child.emit({ type: 'system', subtype: 'init', session_id: 'native-2' })
      child.emit(assistant('entry-9', { session_id: 'native-2' }))
      child.emit(result('native-2'))
    })
    assert.equal(h.children[0].options.resume, 'native-1')
    assert.equal(h.children[0].options.resumeSessionAt, 'entry-1')
    assert.equal(h.children[0].options.forkSession, true)
    assert.equal(events.find((event) => event.type === 'session_updated')?.payload?.providerSessionId, 'native-2')
  } finally {
    await h.adapter.disposeAll()
  }
})
