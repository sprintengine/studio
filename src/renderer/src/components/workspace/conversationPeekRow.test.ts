import assert from 'node:assert/strict'

import {
  agentInitials,
  peekStatusOf,
  rowConversationPeekIdentity,
  rowConversationPeekRoster,
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
  assert.deepEqual(rowConversationPeekRoster({ workspace: {}, sessions: [] }), [], 'no sessions, no roster')
  assert.equal(chat([]), null, 'and no card')
})

run('a row of plain shells has no conversation', () => {
  assert.deepEqual(
    rowConversationPeekRoster({ workspace: {}, sessions: [session({ sessionId: 'sh1', kind: 'terminal' })] }),
    [],
    'a terminal is not a chat',
  )
})

run('the roster opens on the most recently active terminal', () => {
  const roster = rowConversationPeekRoster({
    workspace: {},
    sessions: [
      session({ sessionId: 'old', lastOutputAt: NOW - 600_000 }),
      session({ sessionId: 'new', lastOutputAt: NOW - 1_000 }),
      session({ sessionId: 'shell', kind: 'terminal', lastOutputAt: NOW }),
    ],
  })
  assert.deepEqual(
    roster.map((entry) => entry.sessionId),
    ['new', 'old'],
    'busiest first, and the shell is not in the running — first is what the card opens on',
  )
})

run('a live agent outranks a more recently active exited one', () => {
  const identity = chat([
    session({ sessionId: 'gone', lastOutputAt: NOW - 1_000, exitedAt: NOW - 500, processAlive: false }),
    session({ sessionId: 'here', lastOutputAt: NOW - 600_000 }),
  ])
  assert.equal(identity?.roster[0]?.sessionId, 'here', 'the chat you can still talk to opens the card')
  assert.equal(identity?.roster.length, 2, 'but the finished one is still on the roster')
})

// --- The case the peek exists for: a chat that is not running --------------
run('a suspended session still opens a card', () => {
  const identity = chat([session({ sessionId: 'frozen', processAlive: false, suspended: true })])
  assert.equal(
    identity?.roster[0]?.sessionId,
    'frozen',
    'freeze-the-view killed the process, not the conversation — main still answers for this id',
  )
  assert.equal(identity?.roster[0]?.status?.label, 'Paused', 'and its disc says so')
})

run('an exited session still opens a card', () => {
  const identity = chat([session({ sessionId: 'done', processAlive: false, exitedAt: NOW - 60_000 })])
  assert.equal(identity?.roster[0]?.sessionId, 'done', 'a finished chat is the one you most want to ask about')
  assert.equal(identity?.roster[0]?.status?.label, 'Exited')
})

run('a chat main has never heard of answers from its own agent records', () => {
  const identity = chat([], { a1: agent() }, 'Retry budget for stalled sprints')
  assert.equal(
    identity?.roster[0]?.sessionId,
    'parked-1',
    'after a restart the durable id is the agent record’s cliSessionId — the same id terminalStatus takes',
  )
  assert.equal(identity?.roster[0]?.model, 'claude-opus-5', 'and the record carries the model too')
  assert.equal(identity?.roster[0]?.cli, 'claude-code', 'and the runtime')
  assert.equal(identity?.roster[0]?.status?.label, 'Parked')
})

run('a live session outranks a parked record, and the parked one is not listed twice', () => {
  const identity = chat([session({ sessionId: 'running', agentId: 'a2', lastOutputAt: NOW })], {
    a1: agent({ cliLastExitedAt: NOW - 86_400_000 }),
    a2: agent({ id: 'a2', name: 'Lir Lynch', cliSessionId: 'running' }),
  })
  assert.equal(identity?.roster[0]?.sessionId, 'running', 'a running agent is what the chat opens on')
  assert.deepEqual(
    identity?.roster.map((entry) => entry.sessionId),
    ['running', 'parked-1'],
    'an agent that is both a tracked session and a persisted record appears once',
  )
})

// --- Rosters that could only say nothing are not offered -------------------
run('an agent that has never launched is not on the roster', () => {
  assert.equal(
    chat([], { a1: agent({ cliHasLaunched: false, cliLastExitedAt: null }) }),
    null,
    'no transcript and no sidecar by construction — main would answer "none" and the card would '
      + 'then call a Claude chat a runtime that cannot report',
  )
})

run('an agent with no session id is not on the roster', () => {
  assert.equal(chat([], { a1: agent({ cliSessionId: undefined }) }), null, 'nothing to ask about')
})

run('parked agents are ordered by when their CLI last exited', () => {
  const identity = chat([], {
    old: agent({ id: 'old', cliSessionId: 'old-id', cliLastExitedAt: NOW - 86_400_000 }),
    recent: agent({ id: 'recent', cliSessionId: 'recent-id', cliLastExitedAt: NOW - 60_000 }),
  })
  assert.equal(identity?.roster[0]?.sessionId, 'recent-id', 'the agent you were last working with')
})

run('a roster that ties resolves the same way every render', () => {
  const a = agent({ id: 'a', name: 'Ann Ash', cliSessionId: 'aaa', cliLastExitedAt: null })
  const b = agent({ id: 'b', name: 'Bo Bell', cliSessionId: 'bbb', cliLastExitedAt: null })
  assert.equal(chat([], { a, b })?.roster[0]?.sessionId, 'aaa')
  assert.equal(chat([], { b, a })?.roster[0]?.sessionId, 'aaa')
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

// --- Discs carry WHO, not what ---------------------------------------------
run('a disc wears the agent’s initials, and its name is the accessible one', () => {
  assert.equal(agentInitials('Deara Shea'), 'DS')
  assert.equal(agentInitials('planner-agent'), 'PA', 'a hyphenated name is two words')
  assert.equal(agentInitials('Mira'), 'MI', 'one word gives up its first two letters')
  assert.equal(agentInitials(''), '??', 'never blank')
  const identity = chat([session({ sessionId: 's1', agentId: 'a1' })], { a1: agent() })
  assert.equal(identity?.roster[0]?.initials, 'DS')
  assert.equal(identity?.roster[0]?.name, 'Deara Shea', 'the name travels beside the face')
})

run('the status cluster is terse, because a row is read in a list of forty', () => {
  assert.deepEqual(peekStatusOf('working', ''), { tone: 'good', pulse: true, label: 'Working' })
  assert.deepEqual(peekStatusOf('needs-input', ''), { tone: 'warn', pulse: false, label: 'Waiting' })
  assert.deepEqual(peekStatusOf('failed', ''), { tone: 'error', pulse: false, label: 'Failed' })
  assert.equal(peekStatusOf('idle', '32m')?.label, 'Idle · 32m', 'idle says how long when the row knows')
  assert.equal(peekStatusOf('idle', '')?.label, 'Idle', 'and just "Idle" when it does not')
})

run('the identity names the ROW; everything per-terminal lives on the roster', () => {
  const identity = rowConversationPeekIdentity({
    workspace: {
      name: 'Title tooltips from the first message',
      agents: { a1: agent() },
    },
    sessions: [session({ sessionId: 'sess-1', agentId: 'a1' })],
    status: peekStatusOf('working', ''),
  })
  assert.equal(identity?.name, 'Title tooltips from the first message', 'the card is that row’s card')
  assert.equal(identity?.taskId, null, 'a row never picks one of its agents’ tasks to show')
  assert.equal(identity?.status?.label, 'Working', 'the chat’s state, not a terminal’s')
  assert.equal(
    identity?.roster.length,
    1,
    'one terminal is no roster — and an agent whose record names a STALE session id is still one '
      + 'agent, not a live one plus a parked ghost of itself',
  )
  assert.equal(identity?.roster[0]?.model, 'claude-opus-5', 'the exact model, per terminal')
  assert.equal(identity?.roster[0]?.sessionId, 'sess-1', 'the session main will be asked about')
})

run('a chat with several agents lists them all, ordered, shells excluded', () => {
  const identity = rowConversationPeekIdentity({
    workspace: {
      name: 'Retry budget for stalled sprints',
      agents: {
        a1: agent({ id: 'a1', cliSessionId: 's1' }),
        a2: agent({ id: 'a2', name: 'Lir Lynch', cliSessionId: 's2' }),
      },
    },
    sessions: [
      session({ sessionId: 's1', agentId: 'a1', lastOutputAt: NOW - 1_000 }),
      session({ sessionId: 's2', agentId: 'a2', lastOutputAt: NOW - 900_000 }),
      session({ sessionId: 'sh', kind: 'terminal' }),
    ],
    status: peekStatusOf('working', ''),
  })
  assert.deepEqual(
    identity?.roster.map((entry) => `${entry.initials}:${entry.sessionId}`),
    ['DS:s1', 'LL:s2'],
    'busiest first, shells excluded — and each disc knows who it is',
  )
})

run('an agent the renderer has no record for is still named and still runs something', () => {
  const identity = rowConversationPeekIdentity({
    workspace: { name: 'Headless launch', agents: {} },
    sessions: [
      session({ sessionId: 'sess-2', agentId: 'ghost', agentName: 'guided-brief-1', cli: 'codex' }),
    ],
    status: peekStatusOf('idle', ''),
  })
  assert.equal(identity?.roster[0]?.name, 'guided-brief-1', 'the session’s own label stands in')
  assert.equal(identity?.roster[0]?.initials, 'GB')
  assert.equal(identity?.roster[0]?.cli, 'codex', 'the session knows what it is running')
  assert.equal(identity?.roster[0]?.model, null, 'and claims no model it was never told')
})

process.exit(failures === 0 ? 0 : 1)
