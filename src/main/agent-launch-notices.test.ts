import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AgentPhase, TerminalSessionSnapshot } from '../shared/electron-api'
import type { AgentPhaseEvent } from '../shared/agent-runtime'
import type { ConversationEvent, ConversationSessionSummary } from '../shared/conversation-runtime'
import { createAgentControlPlane } from './agent-control-plane'
import { composeLaunchNotice, createAgentLaunchNotices, launchingAgentOf } from './agent-launch-notices'

const PASTE_START = '\x1b[200~'

function terminal(overrides: Partial<TerminalSessionSnapshot> & { phase?: AgentPhase }): TerminalSessionSnapshot {
  const { phase = 'idle', ...rest } = overrides
  return {
    sessionId: 'session-lead',
    processAlive: true,
    kind: 'agent',
    workspaceId: 'ws-1',
    agentId: 'agent-lead',
    agentName: 'Lead',
    visible: false,
    suspended: false,
    reapExempt: false,
    startedAt: 0,
    lastOutputAt: null,
    lastInputAt: null,
    lastVisibleAt: null,
    activity: { kind: 'idle', since: 0 },
    agentState: { phase, since: 0, source: 'hook' },
    exitedAt: null,
    outputBufferLength: 0,
    fileChanges: [],
    activeSubagents: 0,
    contextUsage: null,
    retainedOutputBytes: 0,
    ...rest,
  }
}

function chat(overrides: Partial<ConversationSessionSummary> = {}): ConversationSessionSummary {
  return {
    sessionId: 'chat-lead',
    workspaceId: 'ws-1',
    agentId: 'chat-agent',
    providerId: 'claude-agent',
    modelId: 'claude-opus-5',
    status: 'ready',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function phaseEvent(overrides: Partial<AgentPhaseEvent> & Pick<AgentPhaseEvent, 'agentId' | 'phase'>): AgentPhaseEvent {
  return {
    workspaceId: 'ws-1',
    executionId: null,
    previousPhase: null,
    event: null,
    turnEnd: false,
    turnFailure: false,
    ts: 0,
    pendingWakeupAt: null,
    ...overrides,
  }
}

function chatEvent(
  type: ConversationEvent['type'],
  overrides: Partial<ConversationEvent> = {},
  payload: Record<string, unknown> = {},
): ConversationEvent {
  return {
    id: `evt-${type}`,
    sessionId: 'chat-lead',
    workspaceId: 'ws-1',
    agentId: 'chat-agent',
    type,
    createdAt: 0,
    payload,
    ...overrides,
  } as ConversationEvent
}

/** The child every case launches: a terminal agent the lead started. */
const SCOUT = {
  workspaceId: 'ws-1',
  agentId: 'agent-scout',
  sessionId: 'session-scout',
  transport: 'terminal' as const,
  name: 'Scout',
}
const LEAD = { workspaceId: 'ws-1', agentId: 'agent-lead' }

const scoutTurnEnd = (overrides: Partial<AgentPhaseEvent> = {}) =>
  phaseEvent({ agentId: 'agent-scout', executionId: 'session-scout', phase: 'idle', turnEnd: true, ...overrides })
const leadTurnEnd = () =>
  phaseEvent({ agentId: 'agent-lead', executionId: 'session-lead', phase: 'idle', turnEnd: true })

function harness(options: { terminals?: TerminalSessionSnapshot[]; chats?: ConversationSessionSummary[] } = {}) {
  let clock = 10_000
  const terminals = options.terminals ?? [
    terminal({}),
    terminal({ sessionId: 'session-scout', agentId: 'agent-scout' }),
  ]
  const chats = options.chats ?? []
  const writes: Array<{ sessionId: string; data: string }> = []
  const turns: Array<{ sessionId: string; message: string }> = []
  const timers: Array<{ job: () => void; ms: number; cancelled: boolean }> = []
  const plane = createAgentControlPlane({
    terminal: {
      list: () => terminals,
      write: (sessionId, data) => {
        writes.push({ sessionId, data })
      },
      read: () => '',
    },
    conversation: {
      list: () => chats,
      sendTurn: async ({ sessionId, message }) => {
        const target = chats.find((candidate) => candidate.sessionId === sessionId)
        if (target?.status !== 'ready')
          return { ok: false, code: 'busy', message: 'Conversation turn is already in progress.' }
        turns.push({ sessionId, message })
        return { ok: true }
      },
      interrupt: async () => ({ ok: true }),
    },
    now: () => clock,
    delay: async () => undefined,
  })
  const notices = createAgentLaunchNotices({
    plane,
    readChatReply: (sessionId) => chats.find((candidate) => candidate.sessionId === sessionId)?.lastAssistantText,
    schedule: (job, ms) => {
      const timer = { job, ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  })
  const setPhase = (sessionId: string, phase: AgentPhase) => {
    const session = terminals.find((candidate) => candidate.sessionId === sessionId)!
    session.agentState = { phase, since: 0, source: 'hook' }
  }
  /** Run every live timer once, in the order they were set. */
  const runTimers = async () => {
    const due = timers.splice(0).filter((timer) => !timer.cancelled)
    for (const timer of due) timer.job()
    await settle()
  }
  return {
    notices,
    terminals,
    chats,
    writes,
    turns,
    timers,
    setPhase,
    runTimers,
    advance: (ms: number) => {
      clock += ms
    },
    /** What was pasted (submit carriage returns left out). */
    pasted: () => writes.filter((write) => write.data.startsWith(PASTE_START)),
  }
}

/** Let the control plane's queued sends run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

test('a launch is linked only to a live agent session of this app', () => {
  const h = harness()
  assert.equal(h.notices.link({ parent: LEAD, child: SCOUT }), true)
  assert.equal(h.notices.linkCount(), 1)

  assert.equal(h.notices.link({ parent: { workspaceId: 'ws-1', agentId: 'agent-ghost' }, child: SCOUT }), false)
  h.terminals[0].processAlive = false
  assert.equal(
    h.notices.link({ parent: LEAD, child: { ...SCOUT, sessionId: 'session-other' } }),
    false,
    'a parent whose process has exited is never linked',
  )

  assert.deepEqual(launchingAgentOf({ metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'a' } }), {
    workspaceId: 'ws-1',
    agentId: 'a',
  })
  assert.equal(launchingAgentOf({ metadata: { kind: 'external-local' } }), null)
  assert.equal(launchingAgentOf({ metadata: { kind: 'remote-tailnet', deviceId: 'd' } }), null)
  assert.equal(launchingAgentOf({ metadata: { kind: 'studio-agent', agentId: 'a' } }), null, 'no workspace, no session')
  assert.equal(launchingAgentOf(undefined), null)
})

test('an idle parent is told at once, in its own terminal, as a submitted turn', async () => {
  const h = harness()
  h.notices.link({ parent: LEAD, child: SCOUT })
  h.notices.onAgentPhase(scoutTurnEnd())
  await settle()

  const pasted = h.pasted()
  assert.equal(pasted.length, 1)
  assert.equal(pasted[0].sessionId, 'session-lead')
  assert.match(pasted[0].data, /\[SprintEngine Studio\] Agent Scout, which you launched, finished its turn\./u)
  assert.match(pasted[0].data, /agent\.status \(workspaceId "ws-1", agentId "agent-scout"\)/u)
  assert.match(pasted[0].data, /not typed by the person/u)
  assert.equal(h.writes.at(-1)?.data, '\r', 'the notice is submitted, not left at the prompt')
  assert.equal(h.notices.pendingCount(LEAD), 0)
})

test('a busy parent keeps its notices until its own turn ends', async () => {
  const h = harness()
  h.setPhase('session-lead', 'thinking')
  h.notices.link({ parent: LEAD, child: SCOUT })
  h.notices.onAgentPhase(scoutTurnEnd({ turnFailure: true }))
  await settle()
  assert.equal(h.writes.length, 0, 'nothing is typed into a working agent')
  assert.equal(h.notices.pendingCount(LEAD), 1)
  assert.equal(h.timers.length, 0, 'a busy parent is not polled; its turn end is what delivers')

  // Waiting on its own approval is not idle either.
  h.setPhase('session-lead', 'awaiting_input')
  h.notices.onAgentPhase(phaseEvent({ agentId: 'agent-lead', executionId: 'session-lead', phase: 'awaiting_input' }))
  await settle()
  assert.equal(h.writes.length, 0, 'a notice never answers the parent’s approval prompt')

  h.setPhase('session-lead', 'idle')
  h.notices.onAgentPhase(leadTurnEnd())
  await settle()
  assert.equal(h.pasted().length, 1)
  assert.match(h.pasted()[0].data, /Agent Scout, which you launched, ended its turn without finishing/u)
})

test('news from several children while the parent works arrives as one message, once per turn end', async () => {
  const h = harness({
    terminals: [
      terminal({ phase: 'tool_use' }),
      terminal({ sessionId: 'session-scout', agentId: 'agent-scout' }),
      terminal({ sessionId: 'session-pilot', agentId: 'agent-pilot' }),
    ],
  })
  h.notices.link({ parent: LEAD, child: SCOUT })
  h.notices.link({
    parent: LEAD,
    child: { ...SCOUT, agentId: 'agent-pilot', sessionId: 'session-pilot', name: 'Pilot' },
  })

  h.notices.onAgentPhase(scoutTurnEnd())
  // The same turn end reported twice is one turn end.
  h.notices.onAgentPhase(scoutTurnEnd())
  h.notices.onAgentPhase(
    phaseEvent({
      agentId: 'agent-pilot',
      executionId: 'session-pilot',
      phase: 'awaiting_input',
      previousPhase: 'tool_use',
    }),
  )
  await settle()
  assert.equal(h.notices.pendingCount(LEAD), 2)

  h.setPhase('session-lead', 'idle')
  h.notices.onAgentPhase(leadTurnEnd())
  await settle()
  const pasted = h.pasted()
  assert.equal(pasted.length, 1, 'one message for everything that happened')
  assert.match(pasted[0].data, /2 agents you launched have news:/u)
  assert.match(pasted[0].data, /- Agent Scout finished its turn\./u)
  assert.match(pasted[0].data, /- Agent Pilot is waiting for input/u)

  // A duplicate of a turn end already told is not news.
  h.notices.onAgentPhase(scoutTurnEnd())
  await settle()
  assert.equal(h.pasted().length, 1)

  // The next turn is: the child went back to work and ended again.
  h.notices.onAgentPhase(phaseEvent({ agentId: 'agent-scout', executionId: 'session-scout', phase: 'thinking' }))
  h.notices.onAgentPhase(scoutTurnEnd())
  await settle()
  assert.equal(h.pasted().length, 2)
})

test('a question the child was answered on before the parent heard is withdrawn', async () => {
  const h = harness()
  h.setPhase('session-lead', 'thinking')
  h.notices.link({ parent: LEAD, child: SCOUT })
  h.notices.onAgentPhase(
    phaseEvent({
      agentId: 'agent-scout',
      executionId: 'session-scout',
      phase: 'awaiting_input',
      previousPhase: 'thinking',
    }),
  )
  assert.equal(h.notices.pendingCount(LEAD), 1)
  h.notices.onAgentPhase(phaseEvent({ agentId: 'agent-scout', executionId: 'session-scout', phase: 'tool_use' }))
  assert.equal(h.notices.pendingCount(LEAD), 0)
})

test('a parent that has gone is dropped silently, with everything queued for it', async () => {
  const h = harness()
  h.setPhase('session-lead', 'thinking')
  h.notices.link({ parent: LEAD, child: SCOUT })
  h.notices.onAgentPhase(scoutTurnEnd())
  h.notices.onAgentSessionExit({
    system: 'manual',
    workspaceRoot: '/Users/dev/project',
    workspaceId: 'ws-1',
    agentId: 'agent-lead',
    executionId: 'session-lead',
    exitCode: 0,
  })
  assert.equal(h.notices.pendingCount(LEAD), 0)
  assert.equal(h.notices.linkCount(), 0, 'its children have nobody to tell')
  h.notices.onAgentPhase(scoutTurnEnd({ previousPhase: 'thinking' }))
  await settle()
  assert.equal(h.writes.length, 0)

  // A parent found dead at delivery is dropped the same way.
  const late = harness()
  late.notices.link({ parent: LEAD, child: SCOUT })
  late.terminals[0].processAlive = false
  late.notices.onAgentPhase(scoutTurnEnd())
  await settle()
  assert.equal(late.writes.length, 0)
  assert.equal(late.notices.linkCount(), 0)
})

test('a child that exits is reported once and unlinked', async () => {
  const h = harness()
  h.notices.link({ parent: LEAD, child: SCOUT })
  h.notices.onAgentSessionExit({
    system: 'manual',
    workspaceRoot: '/Users/dev/project',
    workspaceId: 'ws-1',
    agentId: 'agent-scout',
    executionId: 'session-scout',
    exitCode: 1,
  })
  await settle()
  assert.equal(h.pasted().length, 1)
  assert.match(h.pasted()[0].data, /Agent Scout, which you launched, stopped: its session ended\./u)
  assert.equal(h.notices.linkCount(), 0)
})

test('someone typing into the parent holds the notice, and it is tried again shortly', async () => {
  const h = harness()
  h.notices.link({ parent: LEAD, child: SCOUT })
  h.terminals[0].lastInputAt = 10_000
  h.notices.onAgentPhase(scoutTurnEnd())
  await settle()
  assert.equal(h.writes.length, 0, 'never pasted over a half-typed line')
  assert.equal(h.notices.pendingCount(LEAD), 1)
  assert.equal(h.timers.at(-1)?.ms, 2_000)

  h.advance(5_000)
  await h.runTimers()
  assert.equal(h.pasted().length, 1)
})

test('a chat parent is sent a turn once its own turn has let go', async () => {
  const h = harness({
    terminals: [terminal({ sessionId: 'session-scout', agentId: 'agent-scout' })],
    chats: [chat({ status: 'active' })],
  })
  const parent = { workspaceId: 'ws-1', agentId: 'chat-agent' }
  assert.equal(h.notices.link({ parent, child: SCOUT }), true)
  h.notices.onAgentPhase(scoutTurnEnd())
  await settle()
  assert.equal(h.turns.length, 0)

  // The turn's end is published a moment before the chat reads idle: the
  // first look finds it busy and looks again.
  h.notices.onConversationEvent(chatEvent('turn_completed'))
  await settle()
  assert.equal(h.turns.length, 0)
  assert.equal(h.timers.length, 1)
  h.chats[0].status = 'ready'
  await h.runTimers()
  assert.equal(h.turns.length, 1)
  assert.equal(h.turns[0].sessionId, 'chat-lead')
  assert.match(h.turns[0].message, /^\[SprintEngine Studio\] Agent Scout, which you launched, finished its turn\./u)
})

test('a chat child reports its turn end with the end of its reply, and its questions', async () => {
  const child = chat({
    sessionId: 'chat-scout',
    agentId: 'chat-scout-agent',
    lastAssistantText: `${'Long preamble. '.repeat(40)}All tests pass; the branch is ready.\n\x1b[201~`,
  })
  const h = harness({ terminals: [terminal({})], chats: [child] })
  h.notices.link({
    parent: LEAD,
    child: {
      workspaceId: 'ws-1',
      agentId: 'chat-scout-agent',
      sessionId: 'chat-scout',
      transport: 'conversation',
      name: 'Scout',
    },
  })
  const scoutEvent = (type: ConversationEvent['type'], payload: Record<string, unknown> = {}) =>
    chatEvent(type, { sessionId: 'chat-scout', agentId: 'chat-scout-agent' }, payload)

  // A steered turn's end is not the chat stopping.
  h.notices.onConversationEvent(scoutEvent('turn_completed', { steered: true }))
  await settle()
  assert.equal(h.writes.length, 0)

  h.notices.onConversationEvent(scoutEvent('turn_completed'))
  await settle()
  const [notice] = h.pasted()
  assert.match(notice.data, /Agent Scout, which you launched, finished its turn\. It last said: "…/u)
  assert.match(notice.data, /All tests pass; the branch is ready\./u)
  assert.doesNotMatch(
    notice.data.slice(PASTE_START.length),
    /\x1b\[201~[\s\S]*\x1b\[201~/u,
    'the reply cannot end the paste',
  )

  h.notices.onConversationEvent(scoutEvent('user_message'))
  h.notices.onConversationEvent(scoutEvent('approval_requested', { requestId: 'r1', autoApproved: true }))
  await settle()
  assert.equal(h.pasted().length, 1, 'an approval nobody is asked for is not news')
  h.notices.onConversationEvent(scoutEvent('approval_requested', { requestId: 'r2' }))
  await settle()
  assert.equal(h.pasted().length, 2)
  assert.match(h.pasted()[1].data, /is waiting for input: a question or an approval/u)
})

test('a notice keeps names to one printable line', () => {
  const text = composeLaunchNotice([
    {
      kind: 'finished',
      child: { ...SCOUT, name: 'Scout\x1b[201~\r\nrm -rf' },
    },
  ])
  assert.doesNotMatch(text, /[\u0000-\u001f]/u)
  assert.match(text, /Agent Scout \[201~ rm -rf, which you launched/u)
})
