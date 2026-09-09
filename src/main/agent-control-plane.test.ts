import assert from 'node:assert/strict'
import type { AgentPhase, TerminalSessionSnapshot } from '../shared/electron-api'
import type { ConversationSessionSummary } from '../shared/conversation-runtime'
import {
  createAgentControlPlane,
  parseTarget,
  type ControlPlaneConversationPort,
} from './agent-control-plane'

const tests: Array<{ name: string; body: () => Promise<void> | void }> = []
function run(name: string, body: () => Promise<void> | void): void {
  tests.push({ name, body })
}

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

function agentSession(overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
  return {
    sessionId: 'session-1',
    processAlive: true,
    kind: 'agent',
    visible: false,
    suspended: false,
    reapExempt: false,
    startedAt: 0,
    lastOutputAt: null,
    lastInputAt: null,
    lastVisibleAt: null,
    activity: { kind: 'idle', since: 0 },
    agentState: { phase: 'idle', since: 0, source: 'hook' },
    exitedAt: null,
    outputBufferLength: 0,
    fileChanges: [],
    activeSubagents: 0,
    contextUsage: null,
    retainedOutputBytes: 0,
    ...overrides,
  }
}

function conversationSession(
  overrides: Partial<ConversationSessionSummary> = {}
): ConversationSessionSummary {
  return {
    sessionId: 'chat-1',
    workspaceId: 'ws-1',
    agentId: 'designer',
    providerId: 'claude-agent',
    modelId: 'claude-opus-5',
    status: 'ready',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

// A clock the plane's own waits drive: every `delay` advances it, so readiness
// gates, confirmations and timeouts resolve deterministically without sleeping.
function makeClock(start = 1_000): { now: () => number; delay: (ms: number) => Promise<void> } {
  let current = start
  return {
    now: () => current,
    delay: async (ms: number) => {
      current += ms
    },
  }
}

type Harness = {
  plane: ReturnType<typeof createAgentControlPlane>
  writes: Array<{ sessionId: string; data: string }>
  sessions: TerminalSessionSnapshot[]
  output: Map<string, string>
  now: () => number
}

function makeHarness(
  options: {
    sessions?: TerminalSessionSnapshot[]
    conversation?: ControlPlaneConversationPort
    output?: Map<string, string>
    onWrite?: (sessionId: string, data: string) => void
    throwOnWrite?: string
  } = {}
): Harness {
  const sessions = options.sessions ?? [agentSession()]
  const writes: Array<{ sessionId: string; data: string }> = []
  const output = options.output ?? new Map<string, string>()
  const clock = makeClock()

  const plane = createAgentControlPlane({
    terminal: {
      list: () => sessions,
      write: (sessionId, data) => {
        if (options.throwOnWrite === sessionId) throw new Error('pty is gone')
        writes.push({ sessionId, data })
        // The real runtime stamps `lastInputAt` on every write it accepts; the
        // user-typing guard reads that field, so the fake has to stamp it too.
        const session = sessions.find((entry) => entry.sessionId === sessionId)
        if (session) session.lastInputAt = clock.now()
        options.onWrite?.(sessionId, data)
      },
      read: (sessionId) =>
        sessions.some((entry) => entry.sessionId === sessionId) ? output.get(sessionId) ?? '' : undefined,
    },
    ...(options.conversation ? { conversation: options.conversation } : {}),
    now: clock.now,
    delay: clock.delay,
  })

  return { plane, writes, sessions, output, now: clock.now }
}

// ── Target resolution ───────────────────────────────────────────────────────

run('a bare string is a session id; prefixes select the other axes', () => {
  assert.deepEqual(parseTarget('session-1'), { kind: 'sessionId', value: 'session-1' })
  assert.deepEqual(parseTarget('session:session-1'), { kind: 'sessionId', value: 'session-1' })
  assert.deepEqual(parseTarget('agent:Iona'), { kind: 'agentName', value: 'Iona' })
  assert.deepEqual(parseTarget('agentId:developer-1'), { kind: 'agentId', value: 'developer-1' })
  assert.deepEqual(parseTarget('cwd:/repo/app'), { kind: 'cwd', value: '/repo/app' })
  assert.deepEqual(parseTarget('cli:claude'), { kind: 'cli', value: 'claude' })
  assert.equal(parseTarget(''), null)
  assert.equal(parseTarget('cwd:  '), null)
})

run('an unknown prefix is read as a session id, not an unknown selector', () => {
  // A Windows path or a compound id carries a colon; treating it as a bad
  // selector would refuse a session that exists.
  assert.deepEqual(parseTarget('C:/repo/app'), { kind: 'sessionId', value: 'C:/repo/app' })
})

run('targets resolve by session id, agent name, agent id, cwd and cli', () => {
  const harness = makeHarness({
    sessions: [
      agentSession({
        sessionId: 'session-1',
        agentId: 'developer-1',
        agentName: 'Iona Slane',
        cwd: '/repo/app/worktree',
        cli: 'claude-code',
        workspaceId: 'ws-1',
      }),
      agentSession({ sessionId: 'session-2', agentId: 'reviewer-1', cwd: '/other', cli: 'codex' }),
    ],
  })

  for (const target of [
    'session-1',
    'agent:Iona Slane',
    // Agent NAME matching is case-insensitive; a person types the label they see.
    'agent:iona slane',
    'agentId:developer-1',
    'cwd:/repo/app',
    'cli:claude',
  ] as const) {
    const resolved = harness.plane.resolve(target)
    assert.equal(resolved.ok, true, `${target} resolves`)
    if (resolved.ok) assert.equal(resolved.session.sessionId, 'session-1', `${target} → session-1`)
  }

  const scoped = harness.plane.resolve({ agentId: 'developer-1', workspaceId: 'ws-other' })
  assert.equal(scoped.ok, false, 'a workspace-scoped agent target does not match another workspace')
})

run('an ambiguous target names the candidates instead of guessing one', () => {
  const harness = makeHarness({
    sessions: [
      agentSession({ sessionId: 'session-1', cwd: '/repo/app' }),
      agentSession({ sessionId: 'session-2', cwd: '/repo/app' }),
    ],
  })
  const resolved = harness.plane.resolve('cwd:/repo/app')
  assert.equal(resolved.ok, false)
  if (!resolved.ok) {
    assert.equal(resolved.reason, 'ambiguous')
    assert.deepEqual(resolved.matches, ['session-1', 'session-2'])
  }
})

run('a live session outranks a dead one with the same identity', () => {
  const harness = makeHarness({
    sessions: [
      agentSession({ sessionId: 'dead', agentId: 'developer-1', processAlive: false }),
      agentSession({ sessionId: 'live', agentId: 'developer-1' }),
    ],
  })
  const resolved = harness.plane.resolve('agentId:developer-1')
  assert.equal(resolved.ok, true)
  if (resolved.ok) assert.equal(resolved.session.sessionId, 'live', 'a respawn is never addressed at its corpse')
})

run('a target matching nothing fails as not_found', () => {
  const harness = makeHarness()
  const resolved = harness.plane.resolve('cwd:/nowhere')
  assert.equal(resolved.ok, false)
  if (!resolved.ok) assert.equal(resolved.reason, 'not_found')
})

// ── Submit determinism ──────────────────────────────────────────────────────

run('send pastes the text bracketed and submits with a separate carriage return', async () => {
  const harness = makeHarness()
  const result = await harness.plane.send('session-1', 'do the thing')

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.submitted, true)
    assert.equal(result.transport, 'terminal')
  }
  assert.equal(harness.writes.length, 2, 'the text and the submit are separate writes')
  assert.equal(harness.writes[0].data, `${PASTE_START}do the thing${PASTE_END}`)
  assert.equal(harness.writes[1].data, '\r', 'the CR is dispatched on its own, not inside the paste')
})

run('send with submit false pre-fills the prompt and sends no carriage return', async () => {
  const harness = makeHarness()
  const result = await harness.plane.send('session-1', 'draft', { submit: false })

  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.submitted, false)
  assert.equal(harness.writes.length, 1)
  assert.equal(harness.writes[0].data, `${PASTE_START}draft${PASTE_END}`)
})

run('submit sends the deferred carriage return on its own', async () => {
  const harness = makeHarness()
  await harness.plane.send('session-1', 'draft', { submit: false })
  const result = await harness.plane.submit('session-1')

  assert.equal(result.ok, true)
  assert.deepEqual(harness.writes.map((write) => write.data), [`${PASTE_START}draft${PASTE_END}`, '\r'])
})

run('interrupt sends Ctrl-C', async () => {
  const harness = makeHarness()
  const result = await harness.plane.interrupt('session-1')
  assert.equal(result.ok, true)
  assert.deepEqual(harness.writes, [{ sessionId: 'session-1', data: '\x03' }])
})

// ── Single writer per session ───────────────────────────────────────────────

run('concurrent sends to one session never interleave their bytes', async () => {
  const harness = makeHarness()
  const [first, second] = await Promise.all([
    harness.plane.send('session-1', 'first'),
    harness.plane.send('session-1', 'second'),
  ])

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.deepEqual(
    harness.writes.map((write) => write.data),
    [`${PASTE_START}first${PASTE_END}`, '\r', `${PASTE_START}second${PASTE_END}`, '\r'],
    'the second prompt waits for the first turn to be submitted'
  )
})

run('a raw write queues behind a send instead of splitting its paste and submit', async () => {
  const harness = makeHarness()
  const sending = harness.plane.send('session-1', 'prompt')
  const writing = harness.plane.write('session-1', 'x')
  await Promise.all([sending, writing])

  assert.deepEqual(
    harness.writes.map((write) => write.data),
    [`${PASTE_START}prompt${PASTE_END}`, '\r', 'x']
  )
})

run('sends to different sessions do not block each other', async () => {
  const harness = makeHarness({
    sessions: [agentSession({ sessionId: 'a' }), agentSession({ sessionId: 'b' })],
  })
  await Promise.all([harness.plane.send('a', 'one'), harness.plane.send('b', 'two')])
  assert.equal(harness.writes.filter((write) => write.sessionId === 'a').length, 2)
  assert.equal(harness.writes.filter((write) => write.sessionId === 'b').length, 2)
})

run('the queue drains back to empty', async () => {
  const harness = makeHarness()
  await Promise.all([harness.plane.send('session-1', 'one'), harness.plane.send('session-1', 'two')])
  assert.equal(harness.plane.queueDepth('session-1'), 0)
})

run('a failed send does not poison the queue for the next caller', async () => {
  const sessions = [agentSession()]
  let killOnPaste = true
  const harness = makeHarness({
    sessions,
    onWrite: (_sessionId, data) => {
      // The pty dies the moment the first paste lands.
      if (!killOnPaste || !data.startsWith(PASTE_START)) return
      killOnPaste = false
      sessions[0].processAlive = false
    },
  })

  const failed = await harness.plane.send('session-1', 'one')
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.equal(failed.reason, 'not_alive', 'the submit half refuses a dead pty')

  sessions[0].processAlive = true
  const recovered = await harness.plane.send('session-1', 'two')
  assert.equal(recovered.ok, true, 'the next caller still gets served')
})

// ── Honest failure ──────────────────────────────────────────────────────────

run('a send to a dead session writes nothing and says so', async () => {
  const harness = makeHarness({ sessions: [agentSession({ processAlive: false })] })
  const result = await harness.plane.send('session-1', 'hello')
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'not_alive')
  assert.equal(harness.writes.length, 0)
})

run('a throwing pty write is reported, not swallowed', async () => {
  const harness = makeHarness({ throwOnWrite: 'session-1' })
  const result = await harness.plane.send('session-1', 'hello')
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'write_failed')
    assert.match(result.message, /pty is gone/)
  }
})

run('an empty send is refused rather than writing an empty paste', async () => {
  const harness = makeHarness()
  const result = await harness.plane.send('session-1', '')
  assert.equal(result.ok, false)
  assert.equal(harness.writes.length, 0)
})

// ── Readiness gate ──────────────────────────────────────────────────────────

run('waitForReady holds a send until the agent stops working', async () => {
  const sessions = [agentSession({ agentState: { phase: 'tool_use', since: 0, source: 'hook' } })]
  const writes: Array<{ sessionId: string; data: string }> = []
  let polls = 0
  const clock = makeClock()
  const plane = createAgentControlPlane({
    terminal: {
      // The gate re-reads the session each poll; flip it to idle partway so the
      // send lands only after the agent's turn ended.
      list: () => {
        polls += 1
        if (polls > 3) sessions[0].agentState = { phase: 'idle', since: 0, source: 'hook' }
        return sessions
      },
      write: (sessionId, data) => writes.push({ sessionId, data }),
      read: () => '',
    },
    now: clock.now,
    delay: clock.delay,
  })

  const result = await plane.send('session-1', 'go', { waitForReady: true })
  assert.equal(result.ok, true)
  assert.ok(polls > 3, 'the gate polled while the agent was working')
  assert.equal(writes.length, 2, 'the prompt landed once the agent was idle')
})

run('waitForReady gives up with `busy` when the agent never goes idle', async () => {
  const harness = makeHarness({
    sessions: [agentSession({ agentState: { phase: 'thinking', since: 0, source: 'hook' } })],
  })
  const result = await harness.plane.send('session-1', 'go', {
    waitForReady: true,
    readyTimeoutMs: 500,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'busy')
  assert.equal(harness.writes.length, 0, 'nothing is pasted into a busy agent')
})

run('waitForReady stands down while a person is typing in the pane', async () => {
  const harness = makeHarness({
    sessions: [agentSession({ lastInputAt: 1_000 })],
  })
  const result = await harness.plane.send('session-1', 'go', {
    waitForReady: true,
    readyTimeoutMs: 400,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'user_typing')
  assert.equal(harness.writes.length, 0, 'an automated flush never collides with a human keystroke')
})

run("the plane's own write is not mistaken for a person typing", async () => {
  const harness = makeHarness()
  const first = await harness.plane.send('session-1', 'one')
  assert.equal(first.ok, true)
  // The first send stamped lastInputAt. A gated send right behind it must still
  // go through: that timestamp is ours, not a human's.
  const second = await harness.plane.send('session-1', 'two', { waitForReady: true })
  assert.equal(second.ok, true)
  assert.equal(harness.writes.length, 4)
})

run('a plain shell terminal has no phase and is always ready', async () => {
  const harness = makeHarness({
    sessions: [{ ...agentSession({ kind: 'terminal' }), agentState: undefined }],
  })
  const result = await harness.plane.send('session-1', 'ls', { waitForReady: true })
  assert.equal(result.ok, true)
})

// ── Turn confirmation ───────────────────────────────────────────────────────

run('confirm reports true once the session takes the turn', async () => {
  const sessions = [agentSession()]
  let polls = 0
  const clock = makeClock()
  const plane = createAgentControlPlane({
    terminal: {
      list: () => {
        polls += 1
        if (polls > 4) sessions[0].agentState = { phase: 'thinking', since: 0, source: 'hook' }
        return sessions
      },
      write: () => {},
      read: () => '',
    },
    now: clock.now,
    delay: clock.delay,
  })

  const result = await plane.send('session-1', 'go', { confirm: true })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.confirmed, true)
})

run('confirm reports false when nothing comes back, without failing the send', async () => {
  const harness = makeHarness()
  const result = await harness.plane.send('session-1', 'go', { confirm: true, confirmTimeoutMs: 300 })
  assert.equal(result.ok, true, 'an unconfirmed turn was still written')
  if (result.ok) assert.equal(result.confirmed, false)
})

run('confirm does not count an agent that was already working', async () => {
  // The prompt is buffered behind the turn in flight; "still thinking" is not
  // evidence that this turn was accepted.
  const harness = makeHarness({
    sessions: [agentSession({ agentState: { phase: 'thinking', since: 0, source: 'hook' } })],
  })
  const result = await harness.plane.send('session-1', 'go', { confirm: true, confirmTimeoutMs: 300 })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.confirmed, false)
})

run('confirm counts fresh output on a hookless CLI', async () => {
  const sessions = [{ ...agentSession({ lastOutputAt: 500 }), agentState: undefined }]
  let polls = 0
  const clock = makeClock()
  const plane = createAgentControlPlane({
    terminal: {
      list: () => {
        polls += 1
        if (polls > 3) sessions[0].lastOutputAt = 9_999
        return sessions
      },
      write: () => {},
      read: () => '',
    },
    now: clock.now,
    delay: clock.delay,
  })
  const result = await plane.send('session-1', 'go', { confirm: true })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.confirmed, true)
})

// ── Read and wait ───────────────────────────────────────────────────────────

run('read returns the retained output, and only the last N lines when asked', () => {
  const harness = makeHarness({ output: new Map([['session-1', 'one\ntwo\nthree\nfour']]) })
  const all = harness.plane.read('session-1')
  assert.equal(all.ok, true)
  if (all.ok) assert.equal(all.text, 'one\ntwo\nthree\nfour')

  const tail = harness.plane.read('session-1', { lines: 2 })
  assert.equal(tail.ok, true)
  if (tail.ok) assert.equal(tail.text, 'three\nfour')
})

run('wait resolves on a pattern match', async () => {
  const sessions = [agentSession()]
  let reads = 0
  const clock = makeClock()
  const plane = createAgentControlPlane({
    terminal: {
      list: () => sessions,
      write: () => {},
      // The agent prints its sentinel a few polls in.
      read: () => {
        reads += 1
        return reads > 3 ? 'still working\nDone.' : 'still working'
      },
    },
    now: clock.now,
    delay: clock.delay,
  })

  const result = await plane.wait('session-1', { pattern: /Done\./, timeoutMs: 5_000 })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.matched, 'pattern')
  assert.ok(reads > 3, 'the buffer was polled until it matched')
})

run('wait resolves once a session has been quiet long enough', async () => {
  const harness = makeHarness({ sessions: [agentSession({ lastOutputAt: 0 })] })
  const result = await harness.plane.wait('session-1', { idleMs: 500 })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.matched, 'idle')
})

run('wait times out rather than blocking forever', async () => {
  const harness = makeHarness({ output: new Map([['session-1', 'nothing to match']]) })
  const result = await harness.plane.wait('session-1', { pattern: /never/, timeoutMs: 400 })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'timeout')
})

run('wait needs something to wait for', async () => {
  const harness = makeHarness()
  const result = await harness.plane.wait('session-1', {})
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'invalid_target')
})

// ── Conversation transport ──────────────────────────────────────────────────

run('a conversation session takes a structured turn, never a pty write', async () => {
  const turns: Array<{ sessionId: string; message: string }> = []
  const harness = makeHarness({
    sessions: [],
    conversation: {
      list: () => [conversationSession()],
      sendTurn: async (input) => {
        turns.push(input)
        return { ok: true }
      },
      interrupt: async () => ({ ok: true }),
    },
  })

  const result = await harness.plane.send('chat-1', 'hello there')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.transport, 'conversation')
  assert.deepEqual(turns, [{ sessionId: 'chat-1', message: 'hello there' }])
  assert.equal(harness.writes.length, 0, 'writing \\r at a conversation session would do nothing')
})

run('a rejected conversation turn is reported as a failure', async () => {
  const harness = makeHarness({
    sessions: [],
    conversation: {
      list: () => [conversationSession({ status: 'active' })],
      sendTurn: async () => ({ ok: false, message: 'Conversation turn is already in progress.' }),
      interrupt: async () => ({ ok: true }),
    },
  })
  const result = await harness.plane.send('chat-1', 'hello')
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'write_failed')
    assert.match(result.message, /already in progress/)
  }
})

run('a conversation session refuses the pre-fill and scrollback operations plainly', async () => {
  const harness = makeHarness({
    sessions: [],
    conversation: {
      list: () => [conversationSession()],
      sendTurn: async () => ({ ok: true }),
      interrupt: async () => ({ ok: true }),
    },
  })

  for (const result of [
    await harness.plane.send('chat-1', 'draft', { submit: false }),
    await harness.plane.submit('chat-1'),
    await harness.plane.write('chat-1', '\r'),
    harness.plane.read('chat-1'),
    await harness.plane.wait('chat-1', { idleMs: 10 }),
  ]) {
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'unsupported')
  }
})

run('interrupt routes to the conversation runtime for a chat session', async () => {
  const interrupts: string[] = []
  const harness = makeHarness({
    sessions: [],
    conversation: {
      list: () => [conversationSession({ status: 'active' })],
      sendTurn: async () => ({ ok: true }),
      interrupt: async ({ sessionId }) => {
        interrupts.push(sessionId)
        return { ok: true }
      },
    },
  })
  const result = await harness.plane.interrupt('chat-1')
  assert.equal(result.ok, true)
  assert.deepEqual(interrupts, ['chat-1'])
  assert.equal(harness.writes.length, 0)
})

run('a stopped conversation session is not alive', async () => {
  const harness = makeHarness({
    sessions: [],
    conversation: {
      list: () => [conversationSession({ status: 'stopped' })],
      sendTurn: async () => ({ ok: true }),
      interrupt: async () => ({ ok: true }),
    },
  })
  const result = await harness.plane.send('chat-1', 'hello')
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'not_alive')
})

run('a host with no conversation transport still resolves its terminals', () => {
  const harness = makeHarness()
  assert.equal(harness.plane.listSessions().length, 1)
  const missing = harness.plane.resolve('chat-1')
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.reason, 'not_found')
})

run('both transports appear in one session list with their phases mapped', () => {
  const phases: AgentPhase[] = []
  const harness = makeHarness({
    conversation: {
      list: () => [
        conversationSession({ sessionId: 'chat-ready' }),
        conversationSession({ sessionId: 'chat-active', status: 'active' }),
        conversationSession({ sessionId: 'chat-approval', status: 'awaiting_approval' }),
      ],
      sendTurn: async () => ({ ok: true }),
      interrupt: async () => ({ ok: true }),
    },
  })
  for (const session of harness.plane.listSessions()) {
    if (session.phase) phases.push(session.phase)
  }
  assert.deepEqual(phases, ['idle', 'idle', 'thinking', 'awaiting_input'])
})

async function main(): Promise<void> {
  let failed = false
  for (const test of tests) {
    try {
      await test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failed = true
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  if (failed) process.exit(1)
  console.log('agent-control-plane.test.ts: ok')
}

void main()
