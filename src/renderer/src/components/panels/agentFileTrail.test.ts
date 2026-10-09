import { expect, test } from 'vitest'

import type { ConversationFileActivity, ConversationSessionSummary } from '../../../../shared/conversation-runtime'
import { AGENT_TRAIL_LINGER_MS, agentFileTrail } from './agentFileTrail'

const ROOT = '/Users/dev/app'
const NOW = 100_000

type Session = Parameters<typeof agentFileTrail>[0][number]

function session(
  fileActivity: ConversationFileActivity[],
  overrides: Partial<ConversationSessionSummary> = {},
): Session {
  return { agentId: 'chat-1', status: 'active', phase: 'running', fileActivity, ...overrides }
}

function activity(
  path: string,
  verb: ConversationFileActivity['verb'],
  startedAt: number,
  extra: Partial<ConversationFileActivity> = {},
): ConversationFileActivity {
  return { path: `${ROOT}/${path}`, verb, toolUseId: `${path}@${startedAt}`, startedAt, ...extra }
}

test('a file being read or edited is marked, and so is every folder down to it, the root excluded', () => {
  const trail = agentFileTrail(
    [
      session([
        activity('src/clips/generate.ts', 'reading', NOW - 3_000, { endedAt: NOW - 2_900 }),
        activity('src/render/queue.ts', 'editing', NOW - 1_000),
      ]),
    ],
    ROOT,
    NOW,
  )
  const mark = (path: string) => trail.marks.get(`${ROOT}/${path}`.toLowerCase())
  expect(mark('src/clips/generate.ts')).toEqual({ verb: 'reading', count: 1, here: null })
  // The agent is on the file it touched last.
  expect(mark('src/render/queue.ts')).toEqual({ verb: 'editing', count: 1, here: { agentId: 'chat-1' } })
  // Editing outranks reading on a folder holding both, and the folder leads to the agent.
  expect(mark('src')).toEqual({ verb: 'editing', count: 2, here: { agentId: 'chat-1' } })
  expect(mark('src/clips')).toEqual({ verb: 'reading', count: 1, here: null })
  expect(trail.marks.has(ROOT.toLowerCase())).toBe(false)
  // The read lapses on time, and the tree is told when.
  expect(trail.nextChangeAt).toBe(NOW - 2_900 + AGENT_TRAIL_LINGER_MS)
})

test('a finished call lingers, then goes; the last file an agent touched stays while it works', () => {
  const old = activity('a.ts', 'reading', NOW - 60_000, { endedAt: NOW - 59_000 })
  const older = activity('b.ts', 'reading', NOW - 70_000, { endedAt: NOW - 69_000 })
  const working = agentFileTrail([session([older, old])], ROOT, NOW)
  expect([...working.marks.keys()]).toEqual([`${ROOT}/a.ts`.toLowerCase()])
  // Once the chat stops working, nothing holds it.
  const done = agentFileTrail([session([older, old], { phase: 'completed', status: 'ready' })], ROOT, NOW)
  expect(done.marks.size).toBe(0)
})

test('a call left open on a chat that is not working marks nothing', () => {
  const cut = activity('a.ts', 'editing', NOW - 5_000)
  expect(agentFileTrail([session([cut], { phase: 'completed', status: 'ready' })], ROOT, NOW).marks.size).toBe(0)
})

test("each agent in a chat is on its own file, a spawned one wearing its lane's id", () => {
  const trail = agentFileTrail(
    [
      session([
        activity('main.ts', 'editing', NOW - 2_000),
        activity('docs/guide.md', 'reading', NOW - 1_000, { laneId: 'lane-7' }),
      ]),
    ],
    ROOT,
    NOW,
  )
  expect(trail.marks.get(`${ROOT}/main.ts`.toLowerCase())?.here).toEqual({ agentId: 'chat-1' })
  expect(trail.marks.get(`${ROOT}/docs/guide.md`.toLowerCase())?.here).toEqual({ agentId: 'lane-7' })
})

test('a file outside the root is not marked, and a path matches its row whatever its case', () => {
  const trail = agentFileTrail(
    [
      session([
        { path: '/Users/dev/other/x.ts', verb: 'reading', toolUseId: 'x', startedAt: NOW - 10 },
        { path: '/Users/dev/APP/Readme.md', verb: 'reading', toolUseId: 'y', startedAt: NOW - 5 },
      ]),
    ],
    // A root given with its trailing separator.
    `${ROOT}/`,
    NOW,
  )
  expect([...trail.marks.keys()]).toEqual(['/users/dev/app/readme.md'])
})
