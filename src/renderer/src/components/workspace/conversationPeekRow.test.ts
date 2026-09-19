import assert from 'node:assert/strict'

import { peekStatusOf, rowConversationPeekIdentities } from './conversationPeekRow'
import type { TerminalSessionSnapshot } from '../../../../shared/electron-api'
import type { AgentState } from '../../types/workspace'
import { test } from 'vitest'

test('conversationPeekRow', async () => {
  // QA for what a SIDEBAR ROW hands the peek. A row is a chat and may hold
  // several terminals, so it resolves ONE IDENTITY PER AGENT (2026-09-09) and the
  // shell shows the one whose line the pointer is on. The order still matters:
  // the FIRST is what a row hovered anywhere but on an agent line opens.
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

  const chat = (sessions: TerminalSessionSnapshot[], agents: Record<string, AgentState> = {}, name = 'A chat') =>
    rowConversationPeekIdentities({
      workspace: { name, agents },
      sessions,
      status: peekStatusOf('idle', ''),
      now: NOW,
    })

  /** Session ids in the order the row would offer them. */
  const ids = (identities: ReturnType<typeof chat>): string[] => identities.map((identity) => identity.agent.sessionId)

  run('a row with no terminals has nothing to peek at', () => {
    assert.deepEqual(chat([]), [], 'no sessions, no card')
  })

  run('a row of plain shells has no conversation', () => {
    assert.deepEqual(chat([session({ sessionId: 'sh1', kind: 'terminal' })]), [], 'a terminal is not a chat')
  })

  run('the row opens on the most recently active terminal', () => {
    const identities = chat([
      session({ sessionId: 'old', lastOutputAt: NOW - 600_000 }),
      session({ sessionId: 'new', lastOutputAt: NOW - 1_000 }),
      session({ sessionId: 'shell', kind: 'terminal', lastOutputAt: NOW }),
    ])
    assert.deepEqual(
      ids(identities),
      ['new', 'old'],
      'busiest first, and the shell is not in the running — first is what the card opens on',
    )
  })

  run('a live agent outranks a more recently active exited one', () => {
    const identities = chat([
      session({ sessionId: 'gone', lastOutputAt: NOW - 1_000, exitedAt: NOW - 500, processAlive: false }),
      session({ sessionId: 'here', lastOutputAt: NOW - 600_000 }),
    ])
    assert.equal(ids(identities)[0], 'here', 'the chat you can still talk to opens the card')
    assert.equal(identities.length, 2, 'but the finished one still has a card of its own')
  })

  // --- The case the peek exists for: a chat that is not running --------------
  run('a suspended session still opens a card', () => {
    const identities = chat([
      session({ sessionId: 'frozen', processAlive: false, suspended: true }),
      session({ sessionId: 'other', lastOutputAt: NOW - 900_000 }),
    ])
    const frozen = identities.find((identity) => identity.agent.sessionId === 'frozen')
    assert.ok(frozen, 'freeze-the-view killed the process, not the conversation')
    assert.deepEqual(frozen.status, { kind: 'attention', label: 'Paused' }, 'and its corner says so')
  })

  run('an exited session still opens a card', () => {
    const identities = chat([
      session({ sessionId: 'done', processAlive: false, exitedAt: NOW - 60_000 }),
      session({ sessionId: 'other', lastOutputAt: NOW - 900_000 }),
    ])
    const done = identities.find((identity) => identity.agent.sessionId === 'done')
    assert.ok(done, 'a finished chat is the one you most want to ask about')
    assert.deepEqual(done.status, { kind: 'idle', label: 'Exited' })
  })

  run('a chat main has never heard of answers from its own agent records', () => {
    const identities = chat([], { a1: agent() }, 'Retry budget for stalled runs')
    const only = identities[0]
    assert.ok(only)
    assert.equal(
      only.agent.sessionId,
      'parked-1',
      'after a restart the durable id is the agent record’s cliSessionId — the same id terminalStatus takes',
    )
    assert.equal(only.agent.model, 'claude-opus-5', 'and the record carries the model too')
    assert.equal(only.agent.cli, 'claude-code', 'and the runtime')
    assert.deepEqual(only.agent.fileChanges, [], 'a record is not a session: it has no ledger to report')
    assert.equal(only.agent.contextUsage, null)
  })

  run('a live session outranks a parked record, and the parked one is not listed twice', () => {
    const identities = chat([session({ sessionId: 'running', agentId: 'a2', lastOutputAt: NOW })], {
      a1: agent({ cliLastExitedAt: NOW - 86_400_000 }),
      a2: agent({ id: 'a2', name: 'Lir Lynch', cliSessionId: 'running' }),
    })
    assert.deepEqual(
      ids(identities),
      ['running', 'parked-1'],
      'a running agent leads, and an agent that is both a tracked session and a persisted record appears once',
    )
  })

  // --- Rows that could only say nothing are not offered a card ---------------
  run('an agent that has never launched gets no card', () => {
    assert.deepEqual(
      chat([], { a1: agent({ cliHasLaunched: false, cliLastExitedAt: null }) }),
      [],
      'no transcript and no sidecar by construction — main would answer "none" and the card would ' +
        'then call a Claude chat a runtime that cannot report',
    )
  })

  run('an agent with no session id gets no card', () => {
    assert.deepEqual(chat([], { a1: agent({ cliSessionId: undefined }) }), [], 'nothing to ask about')
  })

  run('parked agents are ordered by when their CLI last exited', () => {
    const identities = chat([], {
      old: agent({ id: 'old', cliSessionId: 'old-id', cliLastExitedAt: NOW - 86_400_000 }),
      recent: agent({ id: 'recent', cliSessionId: 'recent-id', cliLastExitedAt: NOW - 60_000 }),
    })
    assert.equal(ids(identities)[0], 'recent-id', 'the agent you were last working with')
  })

  run('an order that ties resolves the same way every render', () => {
    const a = agent({ id: 'a', name: 'Ann Ash', cliSessionId: 'aaa', cliLastExitedAt: null })
    const b = agent({ id: 'b', name: 'Bo Bell', cliSessionId: 'bbb', cliLastExitedAt: null })
    assert.equal(ids(chat([], { a, b }))[0], 'aaa')
    assert.equal(ids(chat([], { b, a }))[0], 'aaa')
  })

  run('a chat that lives on a paired machine is not offered a card it cannot answer', () => {
    const identities = rowConversationPeekIdentities({
      workspace: {
        name: 'Retry budget',
        remoteOrigin: { machineName: 'studio-mini' } as never,
        agents: { a1: agent() },
      },
      sessions: [],
      status: peekStatusOf('idle', ''),
      now: NOW,
    })
    assert.deepEqual(
      identities,
      [],
      'this main has no session and no sidecar under a remote id — it would call a Claude chat a ' +
        'runtime that cannot report',
    )
  })

  // --- The corner's three kinds ---------------------------------------------
  run('the row status is terse, because a row is read in a list of forty', () => {
    assert.deepEqual(peekStatusOf('working', ''), { kind: 'working', label: 'Working' })
    assert.deepEqual(peekStatusOf('needs-input', ''), { kind: 'attention', label: 'Waiting' })
    assert.deepEqual(peekStatusOf('failed', ''), { kind: 'attention', label: 'Failed' })
    assert.deepEqual(peekStatusOf('idle', '32m'), { kind: 'idle', label: 'Idle · 32m' })
    assert.deepEqual(peekStatusOf('idle', ''), { kind: 'idle', label: 'Idle' }, 'and just "Idle" when it does not know')
  })

  run('one agent takes the ROW’s status, which knows about waiting and about the clock', () => {
    const identities = rowConversationPeekIdentities({
      workspace: { name: 'Title tooltips from the first message', agents: { a1: agent() } },
      sessions: [session({ sessionId: 'sess-1', agentId: 'a1' })],
      status: peekStatusOf('needs-input', ''),
      now: NOW,
    })
    const only = identities[0]
    assert.ok(only)
    assert.equal(only.name, 'Title tooltips from the first message', 'the card is that row’s card')
    assert.deepEqual(
      only.status,
      { kind: 'attention', label: 'Waiting' },
      'a session snapshot cannot know a chat is waiting on you; the row can',
    )
    assert.equal(only.agent.model, 'claude-opus-5', 'the exact model')
    assert.equal(only.agent.sessionId, 'sess-1', 'the session main will be asked about')
  })

  run('several agents each say their OWN state, because each has its own card', () => {
    const identities = rowConversationPeekIdentities({
      workspace: {
        name: 'Retry budget for stalled runs',
        agents: {
          a1: agent({ id: 'a1', cliSessionId: 's1' }),
          a2: agent({ id: 'a2', name: 'Lir Lynch', cliSessionId: 's2' }),
        },
      },
      sessions: [
        session({ sessionId: 's1', agentId: 'a1', lastOutputAt: NOW - 1_000, activity: { kind: 'working' } as never }),
        session({ sessionId: 's2', agentId: 'a2', lastOutputAt: NOW - 900_000 }),
        session({ sessionId: 'sh', kind: 'terminal' }),
      ],
      status: peekStatusOf('working', ''),
      now: NOW,
    })
    assert.deepEqual(ids(identities), ['s1', 's2'], 'busiest first, shells excluded')
    assert.deepEqual(identities[0]?.status, { kind: 'working', label: 'Working' })
    assert.deepEqual(
      identities[1]?.status,
      { kind: 'idle', label: 'Idle · 15m' },
      'the second agent is idle even though the ROW is working — the card is one agent’s',
    )
    assert.equal(identities[0]?.name, 'Retry budget for stalled runs', 'both cards still name the chat')
    assert.equal(identities[1]?.name, 'Retry budget for stalled runs')
  })

  run('the session’s own figures ride the identity, so the card reads no snapshot itself', () => {
    const identities = chat([
      session({
        sessionId: 'sess-1',
        fileChanges: [
          { path: '/repo/src/main/scheduler.ts', additions: 14, deletions: 6, edits: 2, lastEditedAt: NOW },
        ],
        activeSubagents: 2,
        contextUsage: { usedPercentage: 38, at: NOW },
      } as never),
    ])
    const only = identities[0]
    assert.ok(only)
    assert.equal(only.agent.fileChanges.length, 1, 'the ledger this session’s own hooks kept')
    assert.equal(only.agent.activeSubagents, 2)
    assert.deepEqual(only.agent.contextUsage, { usedPercentage: 38, at: NOW })
  })

  run('a session from an older main, with no ledger fields, reads as empty rather than undefined', () => {
    const identities = chat([session({ sessionId: 'legacy' })])
    const only = identities[0]
    assert.ok(only)
    assert.deepEqual(only.agent.fileChanges, [], 'a consumer can count without a guard')
    assert.equal(only.agent.activeSubagents, 0)
    assert.equal(only.agent.contextUsage, null)
  })

  run('an agent the renderer has no record for still runs something', () => {
    const identities = rowConversationPeekIdentities({
      workspace: { name: 'Headless launch', agents: {} },
      sessions: [session({ sessionId: 'sess-2', agentId: 'ghost', agentName: 'roaming-agent-1', cli: 'codex' })],
      status: peekStatusOf('idle', ''),
      now: NOW,
    })
    assert.equal(identities[0]?.agent.cli, 'codex', 'the session knows what it is running')
    assert.equal(identities[0]?.agent.model, null, 'and claims no model it was never told')
  })

  run('a live session hands over its pull requests; a parked record claims none', () => {
    const opened = {
      url: 'https://github.com/acme/multicode/pull/418',
      repoKey: 'github.com/acme/multicode',
      repoName: 'multicode',
      number: 418,
      title: 'Extensions icon carries its unread count',
      state: 'open' as const,
      isDraft: false,
      openedAt: NOW - 3_600_000,
      stateAt: NOW,
    }
    const identities = rowConversationPeekIdentities({
      workspace: {
        name: 'Studio',
        agents: {
          live: { id: 'live', name: 'Live', cliSessionId: 'sess-live', cliHasLaunched: true } as never,
          parked: { id: 'parked', name: 'Parked', cliSessionId: 'sess-parked', cliHasLaunched: true } as never,
        },
      },
      sessions: [session({ sessionId: 'sess-live', agentId: 'live', pullRequests: [opened] })],
      status: peekStatusOf('idle', ''),
      now: NOW,
    })
    const byId = new Map(identities.map((entry) => [entry.agent.sessionId, entry.agent.pullRequests]))
    assert.deepEqual(byId.get('sess-live'), [opened], 'the card shows what the conversation produced')
    // A parked record is not a session: main's record is keyed by repo and branch
    // and there is nothing here to ask about, so an empty list is the honest
    // answer rather than a stale one.
    assert.deepEqual(byId.get('sess-parked'), [])
  })

  if (failures !== 0) process.exit(1)
})
