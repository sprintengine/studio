import assert from 'node:assert/strict'
import type { Workspace } from '../types/workspace'
import {
  keepLaterWorkspaceClocks,
  sortWorkspacesByUserMessage,
  workspaceLastActiveAt,
  workspaceLastUserMessageAt,
  workspaceLastWorkedAt,
} from './workspaceRecency'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const NOW = 1_000_000_000_000
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

// Only the recency-relevant fields matter here; the partition never reads the
// rest of the workspace record. Cast at this test boundary keeps the fixtures
// readable without an `any`.
function makeWorkspace(
  id: string,
  fields: {
    createdAt?: number
    lastTerminalActivityAt?: number | null
    lastUserMessageAt?: number | null
    lastTurnEndedAt?: number | null
  },
): Workspace {
  return {
    id,
    createdAt: fields.createdAt ?? NOW - 30 * DAY,
    lastTerminalActivityAt: fields.lastTerminalActivityAt,
    lastUserMessageAt: fields.lastUserMessageAt,
    lastTurnEndedAt: fields.lastTurnEndedAt,
  } as unknown as Workspace
}

run('workspaceLastWorkedAt prefers the most recent of createdAt and last terminal output', () => {
  assert.equal(
    workspaceLastWorkedAt(makeWorkspace('a', { createdAt: NOW - 10 * DAY, lastTerminalActivityAt: NOW - 2 * DAY })),
    NOW - 2 * DAY,
  )
  // A workspace whose only signal is creation falls back to createdAt.
  assert.equal(
    workspaceLastWorkedAt(makeWorkspace('b', { createdAt: NOW - DAY, lastTerminalActivityAt: null })),
    NOW - DAY,
  )
  // Stale terminal activity never drags recency below createdAt.
  assert.equal(
    workspaceLastWorkedAt(makeWorkspace('c', { createdAt: NOW - DAY, lastTerminalActivityAt: NOW - 9 * DAY })),
    NOW - DAY,
  )
})

run('workspaceLastUserMessageAt is the message clock, and falls back to work only without one', () => {
  // The message wins outright, even against a keystroke that landed since.
  assert.equal(
    workspaceLastUserMessageAt(
      makeWorkspace('spoken', {
        createdAt: NOW - 10 * DAY,
        lastTerminalActivityAt: NOW - MINUTE,
        lastUserMessageAt: NOW - 2 * DAY,
      }),
    ),
    NOW - 2 * DAY,
    'a keystroke after the last message does not move the row',
  )
  // A chat nobody has spoken in — a plain shell, a hookless CLI — keeps the
  // only clock it can have.
  assert.equal(
    workspaceLastUserMessageAt(
      makeWorkspace('shell', {
        createdAt: NOW - 10 * DAY,
        lastTerminalActivityAt: NOW - HOUR,
      }),
    ),
    NOW - HOUR,
  )
  // And one with neither falls all the way back to creation.
  assert.equal(workspaceLastUserMessageAt(makeWorkspace('fresh', { createdAt: NOW })), NOW)
})

run('sending a message is the only thing that moves a row', () => {
  // The bug this ordering exists for (workspace-row-move-on-click, id 88):
  // rows moved while the person was reaching for one. None of the three
  // things that used to move them do any more.
  const spoke = makeWorkspace('spoke', { createdAt: NOW - 10 * DAY, lastUserMessageAt: NOW - HOUR })
  const typed = makeWorkspace('typed', {
    createdAt: NOW - 10 * DAY,
    lastUserMessageAt: NOW - 2 * DAY,
    lastTerminalActivityAt: NOW - MINUTE,
  })
  const finished = makeWorkspace('finished', {
    createdAt: NOW - 10 * DAY,
    lastUserMessageAt: NOW - 3 * DAY,
    lastTurnEndedAt: NOW - MINUTE,
  })
  const opened = makeWorkspace('opened', { createdAt: NOW - 4 * DAY, lastUserMessageAt: NOW - 4 * DAY })

  assert.deepEqual(
    sortWorkspacesByUserMessage([opened, finished, typed, spoke]).map((w) => w.id),
    ['spoke', 'typed', 'finished', 'opened'],
    'a keystroke and an agent finishing leave the order alone; only the messages decide it',
  )
})

run('sortWorkspacesByUserMessage puts the chat you just messaged on top', () => {
  const older = makeWorkspace('older', { createdAt: NOW - 30 * DAY, lastUserMessageAt: NOW - 12 * MINUTE })
  const newer = makeWorkspace('newer', { createdAt: NOW - 30 * DAY, lastUserMessageAt: NOW - 2 * MINUTE })
  const oldest = makeWorkspace('oldest', { createdAt: NOW - 30 * DAY, lastUserMessageAt: NOW - 90 * MINUTE })

  // No tie window: two messages ten minutes apart are ten minutes apart, and
  // the order is a pure function of the stamps rather than of the clock.
  assert.deepEqual(
    sortWorkspacesByUserMessage([older, newer, oldest]).map((w) => w.id),
    ['newer', 'older', 'oldest'],
  )
})

run('sortWorkspacesByUserMessage is stable for exact ties and does not mutate input', () => {
  const a = makeWorkspace('a', { createdAt: NOW })
  const b = makeWorkspace('b', { createdAt: NOW })
  const c = makeWorkspace('c', { createdAt: NOW })
  const input = [a, b, c]

  const sorted = sortWorkspacesByUserMessage(input)

  assert.deepEqual(
    sorted.map((w) => w.id),
    ['a', 'b', 'c'],
  )
  // Pure: the caller's array is untouched.
  assert.notEqual(sorted, input)
  assert.deepEqual(
    input.map((w) => w.id),
    ['a', 'b', 'c'],
  )
})

// The banding that used to sit on top of this order is gone (owner ruling
// 2026-09-09). What an agent is doing decides how a row looks, never where it
// sits, so the three cases below all assert the same thing from different
// angles: only a message moves a row.
run('a finished agent does not lift its row: the turn-end clock is not read', () => {
  // What "finished" is, to the stored record: `lastTurnEndedAt` moves. That
  // clock used to reach the order through the done band, which lifted the green
  // row over chats spoken in more recently. The comparator must not see it.
  const spokenInRecently = makeWorkspace('spoken-in-recently', {
    createdAt: NOW - 5 * DAY,
    lastUserMessageAt: NOW - 40 * MINUTE,
    lastTurnEndedAt: NOW - 5 * DAY,
  })
  const justFinished = makeWorkspace('just-finished', {
    createdAt: NOW - 5 * DAY,
    lastUserMessageAt: NOW - HOUR,
    lastTurnEndedAt: NOW,
  })

  assert.deepEqual(
    sortWorkspacesByUserMessage([spokenInRecently, justFinished]).map((w) => w.id),
    ['spoken-in-recently', 'just-finished'],
    'the row whose agent just finished stays below the one spoken in more recently',
  )
})

run('an agent working in a chat does not lift its row either', () => {
  // A working or blocked agent writes to the pty, which moves
  // `lastTerminalActivityAt`. That clock is the fallback only — a row that has
  // a message stamp never reads it, so nothing the agent does can outrank what
  // the person said.
  const spokenInRecently = makeWorkspace('spoken-in-recently', {
    createdAt: NOW - 5 * DAY,
    lastTerminalActivityAt: NOW - 5 * DAY,
    lastUserMessageAt: NOW - 40 * MINUTE,
  })
  const busy = makeWorkspace('busy', {
    createdAt: NOW - 5 * DAY,
    lastTerminalActivityAt: NOW,
    lastUserMessageAt: NOW - HOUR,
  })

  assert.deepEqual(
    sortWorkspacesByUserMessage([spokenInRecently, busy]).map((w) => w.id),
    ['spoken-in-recently', 'busy'],
    'a live pty does not outrank the message clock',
  )
})

run('the order is a pure function of the message clock, whatever order it arrives in', () => {
  // Nothing about where a row sits may depend on where it sat: the store hands
  // the sidebar its rows in creation order, a folder regroups them, a drag
  // reorders them. Every permutation of the same three records must deal the
  // same list.
  const a = makeWorkspace('a', { createdAt: NOW - 5 * DAY, lastUserMessageAt: NOW - 40 * MINUTE })
  const b = makeWorkspace('b', { createdAt: NOW - 5 * DAY, lastUserMessageAt: NOW - HOUR })
  const c = makeWorkspace('c', { createdAt: NOW - 5 * DAY, lastUserMessageAt: NOW - 5 * DAY })
  const permutations = [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ]

  for (const input of permutations) {
    assert.deepEqual(
      sortWorkspacesByUserMessage(input).map((w) => w.id),
      ['a', 'b', 'c'],
      `input order ${input.map((w) => w.id).join('')} deals the same list`,
    )
  }
})

run('a newer last message moves the row to the top of its group', () => {
  // The one event that is allowed to reorder anything.
  const spokenIn = makeWorkspace('spoken-in', { createdAt: NOW - 5 * DAY, lastUserMessageAt: NOW - 5 * DAY })
  const others = [
    makeWorkspace('a', { createdAt: NOW - 5 * DAY, lastUserMessageAt: NOW - 40 * MINUTE }),
    makeWorkspace('b', { createdAt: NOW - 5 * DAY, lastUserMessageAt: NOW - DAY }),
  ]

  assert.deepEqual(
    sortWorkspacesByUserMessage([...others, spokenIn]).map((w) => w.id),
    ['a', 'b', 'spoken-in'],
  )

  const afterMessage = makeWorkspace('spoken-in', { createdAt: NOW - 5 * DAY, lastUserMessageAt: NOW })
  assert.deepEqual(
    sortWorkspacesByUserMessage([...others, afterMessage]).map((w) => w.id),
    ['spoken-in', 'a', 'b'],
  )
})

// The rest rule's clock is a different question from the order, and stays the
// one it was: an agent that spoke a minute ago means the chat is not quiet,
// even though the person has not messaged it since yesterday.
run("workspaceLastActiveAt counts the agent's turn and the person's message", () => {
  const finished = makeWorkspace('finished', {
    createdAt: NOW - DAY,
    lastTerminalActivityAt: NOW - 26 * HOUR,
    lastUserMessageAt: NOW - 26 * HOUR,
    lastTurnEndedAt: NOW - MINUTE,
  })

  assert.equal(workspaceLastActiveAt(finished), NOW - MINUTE, 'a finished turn is activity')
  assert.equal(
    workspaceLastUserMessageAt(finished),
    NOW - 26 * HOUR,
    'but it is not the person speaking, so the order does not hear it',
  )

  // A conversation-runtime chat: no pty, so no keystroke clock and no turn
  // end. Its message is the only thing that says it is not idle, and the rest
  // sweep would shelve it three days after creation without it.
  const conversation = makeWorkspace('conversation', {
    createdAt: NOW - 30 * DAY,
    lastUserMessageAt: NOW - MINUTE,
  })
  assert.equal(workspaceLastActiveAt(conversation), NOW - MINUTE, 'a message is activity too')
})

run('keepLaterWorkspaceClocks never rolls an activity clock back', () => {
  const existing = makeWorkspace('w', {
    lastTerminalActivityAt: NOW - DAY,
    lastUserMessageAt: NOW - DAY,
    lastTurnEndedAt: NOW - 2 * DAY,
  })
  const older = makeWorkspace('w', {
    lastTerminalActivityAt: NOW - 3 * DAY,
    lastUserMessageAt: NOW - 3 * DAY,
    lastTurnEndedAt: null,
  })
  const merged = keepLaterWorkspaceClocks(existing, older)
  assert.equal(merged.lastTerminalActivityAt, NOW - DAY, 'the later input clock wins')
  assert.equal(merged.lastUserMessageAt, NOW - DAY, 'and so does the later message clock')
  assert.equal(merged.lastTurnEndedAt, NOW - 2 * DAY, 'an absent incoming clock keeps the known one')
  assert.notEqual(merged, older, 'a merge is a new object')

  const newer = makeWorkspace('w', {
    lastTerminalActivityAt: NOW,
    lastUserMessageAt: NOW,
    lastTurnEndedAt: NOW,
  })
  assert.equal(keepLaterWorkspaceClocks(existing, newer), newer, 'a newer record passes through untouched')
  assert.equal(keepLaterWorkspaceClocks(makeWorkspace('w', {}), older), older, 'nothing known, nothing kept')
})

console.log('workspaceRecency.test.ts: ok')
