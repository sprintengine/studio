import assert from 'node:assert/strict'

import {
  parkedPeekAgentOf,
  peekSessionOf,
  peekStatusOf,
  rowConversationPeekIdentity,
} from './conversationPeekRow'
import type { TerminalSessionSnapshot } from '../../../../shared/electron-api'
import type { AgentState } from '../../types/workspace'

// QA for the choice a SIDEBAR ROW has to make that a tab does not: a row is a
// chat, which may hold several terminals, so it has to pick the one whose
// conversation the card reads — and pick the same one every time.
//
// The other half is WHICH rows get a card at all. A peek is asked for most
// about the chat that is not running, so the gate is "is there a session id
// worth asking about", never "is this process alive": a suspended session, an
// exited one, and a chat main has never heard of but whose agent record
// remembers its id all have to open. A chat that could only answer nothing —
// no id, or an agent that never launched — must not.

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

const NOW = 1_800_000_000_000

const session = (over: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot =>
  ({
    sessionId: 's1',
    processAlive: true,
    kind: 'agent',
    visible: true,
    suspended: false,
    reapExempt: false,
    startedAt: NOW - 3_600_000,
    lastOutputAt: null,
    lastInputAt: null,
    lastVisibleAt: null,
    activity: 'idle',
    exitedAt: null,
    outputBufferLength: 0,
    retainedOutputBytes: 0,
    ...over,
  }) as TerminalSessionSnapshot

const agent = (over: Partial<AgentState> = {}): AgentState =>
  ({
    id: 'a1',
    name: 'Deara Shea',
    cli: 'claude-code',
    cliModel: 'claude-opus-5',
    cliSessionId: 'parked-1',
    cliHasLaunched: true,
    cliLastExitedAt: NOW - 3_600_000,
    ...over,
  }) as AgentState

const chat = (
  sessions: TerminalSessionSnapshot[],
  agents: Record<string, AgentState> = {},
  name = 'A chat',
) =>
  rowConversationPeekIdentity({
    workspace: { name, agents },
    sessions,
    status: peekStatusOf('idle', ''),
  })

run('a row with no terminals has nothing to peek at', () => {
  assert.equal(peekSessionOf([]), null, 'no sessions, no card')
})

run('a row of plain shells has no conversation', () => {
  assert.equal(
    peekSessionOf([session({ sessionId: 'sh1', kind: 'shell' })]),
    null,
    'a terminal is not a chat',
  )
})

run('the most recently active agent is the one the card reads', () => {
  const picked = peekSessionOf([
    session({ sessionId: 'old', lastOutputAt: NOW - 600_000 }),
    session({ sessionId: 'new', lastOutputAt: NOW - 1_000 }),
    session({ sessionId: 'shell', kind: 'shell', lastOutputAt: NOW }),
  ])
  assert.equal(picked?.sessionId, 'new', 'the busiest agent wins; the shell is not in the running')
})

// Through the real caller, not `peekSessionOf` alone: the row now hands over
// every session main knows about, so a mixed row is a shape that actually
// reaches this sort rather than a hand-built one.
run('a live agent outranks a more recently active exited one', () => {
  const identity = chat([
    session({ sessionId: 'gone', lastOutputAt: NOW - 1_000, exitedAt: NOW - 500, processAlive: false }),
    session({ sessionId: 'here', lastOutputAt: NOW - 600_000 }),
  ])
  assert.equal(identity?.sessionId, 'here', 'the chat you can still talk to is the chat')
})

// --- The case the peek exists for: a chat that is not running --------------
run('a suspended session still opens a card', () => {
  const identity = chat([
    session({ sessionId: 'frozen', processAlive: false, suspended: true }),
  ])
  assert.equal(
    identity?.sessionId,
    'frozen',
    'freeze-the-view killed the process, not the conversation — main still answers for this id',
  )
})

run('an exited session still opens a card', () => {
  const identity = chat([
    session({ sessionId: 'done', processAlive: false, exitedAt: NOW - 60_000 }),
  ])
  assert.equal(identity?.sessionId, 'done', 'a finished chat is the one you most want to ask about')
})

run('a chat main has never heard of answers from its own agent record', () => {
  const identity = chat([], { a1: agent() }, 'Retry budget for stalled sprints')
  assert.equal(
    identity?.sessionId,
    'parked-1',
    'after a restart the durable id is the agent record’s cliSessionId — the same id terminalStatus takes',
  )
  assert.equal(identity?.model, 'claude-opus-5', 'and the record carries the model too')
  assert.equal(identity?.cli, 'claude-code', 'and the runtime')
})

run('a live session outranks a parked record for the same chat', () => {
  const identity = chat([session({ sessionId: 'running', agentId: 'a2' })], {
    a1: agent(),
    a2: agent({ id: 'a2', name: 'Lir Lynch', cliSessionId: 'running' }),
  })
  assert.equal(identity?.sessionId, 'running', 'a running agent is still what the chat is about')
})

// --- Cards that could only say nothing are not offered ---------------------
run('an agent that has never launched opens no card', () => {
  assert.equal(
    chat([], { a1: agent({ cliHasLaunched: false, cliLastExitedAt: null }) }),
    null,
    'no transcript and no sidecar by construction — main would answer "none" and the card would '
      + 'then call a Claude chat a runtime that cannot report',
  )
})

run('an agent with no session id opens no card', () => {
  assert.equal(chat([], { a1: agent({ cliSessionId: undefined }) }), null, 'nothing to ask about')
})

run('parked agents are ordered by when their CLI last exited', () => {
  const picked = parkedPeekAgentOf({
    old: agent({ id: 'old', cliSessionId: 'old-id', cliLastExitedAt: NOW - 86_400_000 }),
    recent: agent({ id: 'recent', cliSessionId: 'recent-id', cliLastExitedAt: NOW - 60_000 }),
  })
  assert.equal(picked?.cliSessionId, 'recent-id', 'the agent you were last working with')
})

run('parked agents that tie resolve the same way every render', () => {
  const a = agent({ id: 'a', cliSessionId: 'aaa', cliLastExitedAt: null })
  const b = agent({ id: 'b', cliSessionId: 'bbb', cliLastExitedAt: null })
  assert.equal(parkedPeekAgentOf({ a, b })?.cliSessionId, 'aaa')
  assert.equal(parkedPeekAgentOf({ b, a })?.cliSessionId, 'aaa')
})

run('two sessions that tie always resolve the same way', () => {
  const a = session({ sessionId: 'aaa' })
  const b = session({ sessionId: 'bbb' })
  assert.equal(peekSessionOf([a, b])?.sessionId, 'aaa', 'stable by id')
  assert.equal(peekSessionOf([b, a])?.sessionId, 'aaa', 'and independent of arrival order')
})

run('the status cluster is terse, because a row is read in a list of forty', () => {
  assert.deepEqual(peekStatusOf('working', ''), { tone: 'good', pulse: true, label: 'Working' })
  assert.deepEqual(peekStatusOf('needs-input', ''), { tone: 'warn', pulse: false, label: 'Waiting' })
  assert.deepEqual(peekStatusOf('failed', ''), { tone: 'error', pulse: false, label: 'Failed' })
  assert.equal(peekStatusOf('idle', '32m').label, 'Idle · 32m', 'idle says how long when the row knows')
  assert.equal(peekStatusOf('idle', '').label, 'Idle', 'and just "Idle" when it does not')
})

run('the identity names the ROW, and takes the model from the agent record', () => {
  const identity = rowConversationPeekIdentity({
    workspace: {
      name: 'Title tooltips from the first message',
      agents: {
        a1: { id: 'a1', name: 'Deara Shea', cli: 'claude-code', cliModel: 'claude-opus-5' } as never,
      },
    },
    sessions: [session({ sessionId: 'sess-1', agentId: 'a1' })],
    status: peekStatusOf('working', ''),
  })
  assert.equal(identity?.name, 'Title tooltips from the first message', 'the card is that row’s card')
  assert.equal(identity?.model, 'claude-opus-5', 'the exact model')
  assert.equal(identity?.cli, 'claude-code', 'the runtime mark')
  assert.equal(identity?.sessionId, 'sess-1', 'the session main will be asked about')
  assert.equal(identity?.taskId, null, 'a row never picks one of its agents’ tasks to show')
  assert.equal(identity?.agentScope, null, 'a one-agent chat has nothing to disclaim')
})

run('a chat with several agents names the one being shown, and how many there are', () => {
  const identity = rowConversationPeekIdentity({
    workspace: {
      name: 'Retry budget for stalled sprints',
      agents: {
        a1: { id: 'a1', name: 'Deara Shea', cli: 'claude-code', cliModel: 'claude-opus-5' } as never,
        a2: { id: 'a2', name: 'Lir Lynch', cli: 'claude-code' } as never,
      },
    },
    sessions: [
      session({ sessionId: 's1', agentId: 'a1', lastOutputAt: NOW - 1_000 }),
      session({ sessionId: 's2', agentId: 'a2', lastOutputAt: NOW - 900_000 }),
      session({ sessionId: 'sh', kind: 'shell' }),
    ],
    status: peekStatusOf('working', ''),
  })
  assert.equal(identity?.sessionId, 's1', 'the busiest agent is the one quoted')
  assert.deepEqual(
    identity?.agentScope,
    { agentName: 'Deara Shea', total: 2 },
    'and the card is told to say so — shells are not agents, so the count is two',
  )
})

run('an agent counted from both sources is counted once', () => {
  const identity = chat(
    [session({ sessionId: 'shared', agentId: 'a1', lastOutputAt: NOW })],
    {
      a1: agent({ id: 'a1', cliSessionId: 'shared' }),
      a2: agent({ id: 'a2', name: 'Lir Lynch', cliSessionId: 'parked-2', cliLastExitedAt: NOW - 10_000 }),
    },
  )
  assert.equal(
    identity?.agentScope?.total,
    2,
    'a parked record whose session main is still tracking is one agent, not two',
  )
  assert.equal(identity?.agentScope?.agentName, 'Deara Shea', 'and the live one is the one being shown')
})

run('a chat that lives on a paired machine is not offered a card it cannot answer', () => {
  const identity = rowConversationPeekIdentity({
    workspace: {
      name: 'Retry budget',
      remoteOrigin: { machineName: 'studio-mini' } as never,
      agents: { a1: agent() },
    },
    sessions: [],
    status: peekStatusOf('idle', ''),
  })
  assert.equal(
    identity,
    null,
    'this main has no session and no sidecar under a remote id — it would call a Claude chat a '
      + 'runtime that cannot report',
  )
})

run('a parked chat with one agent disclaims nothing', () => {
  assert.equal(chat([], { a1: agent() })?.agentScope, null, 'one agent is not a roster')
})

run('an agent with no record still gets named, never left blank in the scope line', () => {
  const identity = rowConversationPeekIdentity({
    workspace: { name: 'Headless pair', agents: {} },
    sessions: [
      session({ sessionId: 's1', agentId: 'ghost', agentName: 'guided-brief-1', lastOutputAt: NOW }),
      session({ sessionId: 's2', agentId: 'ghost2' }),
    ],
    status: peekStatusOf('idle', ''),
  })
  assert.equal(identity?.agentScope?.agentName, 'guided-brief-1', 'the session’s own label stands in')
  assert.equal(identity?.agentScope?.total, 2)
})

run('an agent the renderer has no record for still gets its runtime from the session', () => {
  const identity = rowConversationPeekIdentity({
    workspace: { name: 'Headless launch', agents: {} },
    sessions: [session({ sessionId: 'sess-2', agentId: 'ghost', cli: 'codex' })],
    status: peekStatusOf('idle', ''),
  })
  assert.equal(identity?.cli, 'codex', 'the session knows what it is running')
  assert.equal(identity?.model, null, 'and claims no model it was never told')
})

run('a row with nothing to read yields no identity, so no card opens', () => {
  assert.equal(
    rowConversationPeekIdentity({
      workspace: { name: 'Just a terminal', agents: {} },
      sessions: [session({ kind: 'shell' })],
      status: peekStatusOf('idle', ''),
    }),
    null,
    'a card that only restated the row’s title is the noise this replaced',
  )
})

process.exit(failures === 0 ? 0 : 1)
