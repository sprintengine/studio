// The task detail pane's read model (item 2029). Everything the pane renders in
// its four groups is shaped here, so the shaping is provable without a renderer:
// module names, the elapsed window, diff totals, the activity sparkline, the one
// merged timeline, and the lifecycle glyph each entry kind reads as.
//
//   npm run test:renderer:sprintengine-inspector

import assert from 'node:assert/strict'

import type {
  SprintEngineEvent,
  SprintEngineTask,
  SprintEngineTaskActivityEntry,
} from '../../types/workspace'
import {
  buildTaskTimeline,
  formatElapsed,
  taskActivitySparkline,
  taskDiffTotals,
  taskElapsedMs,
  taskModuleLabels,
  timelineItemLifecycle,
} from './sprintEngineInspector'

function activity(
  id: string,
  timestamp: string,
  type: SprintEngineTaskActivityEntry['type'],
  extra: Partial<SprintEngineTaskActivityEntry> = {},
): SprintEngineTaskActivityEntry {
  return { id, timestamp, type, actor: 'developer-1', message: '', ...extra }
}

function event(id: string, timestamp: string, type: string, message: string): SprintEngineEvent {
  return { id, timestamp, type, actor: 'sprintengine', message }
}

function task(overrides: Partial<SprintEngineTask> = {}): SprintEngineTask {
  return {
    id: 'T2',
    title: 'Retry failed webhook deliveries',
    role: 'developer',
    repo: 'primary',
    status: 'in_progress',
    ownerAgentId: 'developer-1',
    dependsOn: [],
    ownedPaths: [],
    acceptanceCriteria: [],
    implementationNotes: [],
    evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
    notes: [],
    comments: [],
    startedAt: null,
    completedAt: null,
    ...overrides,
  } as SprintEngineTask
}

/* ---- modules ---------------------------------------------------------- */

{
  const labels = taskModuleLabels(['src/renderer/src/components/panels', 'src/main/webhooks/'])
  assert.deepEqual(
    labels.map((entry) => entry.name),
    ['panels', 'webhooks'],
    'a module reads as its own directory name, not the whole path',
  )
  assert.equal(labels[1].path, 'src/main/webhooks', 'the declared path survives for the row title')
}

{
  const labels = taskModuleLabels(['src/board/panels', 'src/inspector/panels'])
  assert.deepEqual(
    labels.map((entry) => entry.name),
    ['board/panels', 'inspector/panels'],
    'colliding directory names widen until they are distinguishable',
  )
}

{
  assert.deepEqual(
    taskModuleLabels(['src\\main\\vcs', 'src/main/vcs', '', '  ']),
    [{ name: 'vcs', path: 'src/main/vcs' }],
    'separators are normalized and duplicates collapse to one entry',
  )
}

/* ---- elapsed ---------------------------------------------------------- */

{
  const now = Date.parse('2026-07-30T15:00:00Z')
  assert.equal(taskElapsedMs(task(), now), null, 'an unstarted task has no elapsed time, not zero')
  assert.equal(
    taskElapsedMs(task({ startedAt: '2026-07-30T14:00:00Z' }), now),
    3_600_000,
    'an open task is measured to now',
  )
  assert.equal(
    taskElapsedMs(
      task({ startedAt: '2026-07-30T14:00:00Z', completedAt: '2026-07-30T14:30:00Z' }),
      now,
    ),
    1_800_000,
    'a finished task stops at its completion',
  )
}

assert.equal(formatElapsed(48_000), '48s')
assert.equal(formatElapsed(12 * 60_000), '12m')
assert.equal(formatElapsed(62 * 60_000), '1h 02m')
assert.equal(formatElapsed(3 * 86_400_000 + 4 * 3_600_000), '3d 04h')

/* ---- diff ------------------------------------------------------------- */

{
  // The capture provenance a real diff carries. Irrelevant to the totals under
  // test, but required by the type, so it lives in one shared base.
  const diffBase = {
    capturedAt: '2026-01-01T00:00:00.000Z',
    capturedBy: 'developer',
    source: 'working_tree' as const,
    binary: false,
    truncated: false,
    hunks: [],
  }
  assert.equal(taskDiffTotals(task()), null, 'no captured diff reads as no diff, never as +0 −0')
  const totals = taskDiffTotals(
    task({
      evidence: {
        summary: '',
        touchedFiles: [],
        commandsRan: [],
        results: [],
        diffs: [
          { ...diffBase, path: 'a.ts', status: 'modified', additions: 100, deletions: 30 },
          { ...diffBase, path: 'b.ts', status: 'added', additions: 47, deletions: 10 },
        ],
      },
    } as Partial<SprintEngineTask>),
  )
  assert.deepEqual(totals, { additions: 147, deletions: 40, files: 2 })
}

/* ---- sparkline -------------------------------------------------------- */

{
  const startMs = Date.parse('2026-07-30T14:00:00Z')
  const endMs = Date.parse('2026-07-30T15:00:00Z')
  const bars = taskActivitySparkline(
    [
      '2026-07-30T14:01:00Z',
      '2026-07-30T14:02:00Z',
      '2026-07-30T14:03:00Z',
      '2026-07-30T14:58:00Z',
    ],
    { startMs, endMs },
    4,
  )
  assert.equal(bars.length, 4)
  assert.equal(bars[0].height, 1, 'the busiest bucket is full height — the scale is its own')
  assert.ok(bars[1].height === 0 && bars[2].height === 0, 'quiet buckets are empty, not floored')
  assert.ok(bars[3].height > 0 && bars[3].height < 1, 'a lone event still paints')
  assert.deepEqual(
    bars.map((bar) => bar.recent),
    [false, false, false, true],
    'only the bucket holding the newest entry is the accent one',
  )
  assert.deepEqual(
    taskActivitySparkline(['2026-07-30T14:01:00Z'], { startMs, endMs }, 4),
    [],
    'one stamp is not a shape — the readout shows the figure alone',
  )
  assert.deepEqual(
    taskActivitySparkline(['2026-07-30T14:01:00Z', '2026-07-30T14:02:00Z'], { startMs, endMs: startMs }, 4),
    [],
    'a window with no width yields no bars',
  )
}

/* ---- timeline merge --------------------------------------------------- */

{
  const merged = buildTaskTimeline(
    task({
      activity: [
        activity('ACT-001', '2026-07-30T14:02:00Z', 'claim'),
        activity('ACT-002', '2026-07-30T14:31:00Z', 'comment', { message: 'Cap is off by one.' }),
      ],
    }),
    [
      event('EVT-001', '2026-07-30T14:40:00Z', 'task_changes_committed', 'developer-1 committed Sprint Engine changes for T2: abc123.'),
      event('EVT-002', '2026-07-30T14:41:00Z', 'task_changes_committed', 'developer-3 committed Sprint Engine changes for T21: def456.'),
      event('EVT-003', '2026-07-30T14:52:00Z', 'run_pull_request_opened', 'Opened pull request for sprint/x: https://example.test/pr/206.'),
    ],
  )
  assert.deepEqual(
    merged.map((item) => item.key),
    ['event:EVT-003', 'event:EVT-001', 'activity:ACT-002', 'activity:ACT-001'],
    'one stream, newest first, activity and VCS milestones interleaved',
  )
  assert.ok(
    !merged.some((item) => item.key === 'event:EVT-002'),
    'T21 is not T2 — attribution is a whole-token match, never a prefix',
  )
}

{
  const noCommits = buildTaskTimeline(task({ activity: [] }), [
    event('EVT-003', '2026-07-30T14:52:00Z', 'run_pull_request_opened', 'Opened pull request for sprint/x.'),
  ])
  assert.deepEqual(noCommits, [], 'a task with no commit in the PR does not claim the PR as its own')
}

{
  // An undated commit event cannot anchor the window: `>= ''` would be true for
  // every pull request in the run.
  const undated = buildTaskTimeline(task({ activity: [] }), [
    { id: 'EVT-001', timestamp: '', type: 'task_changes_committed', actor: 'developer-1', message: 'developer-1 committed Sprint Engine changes for T2: abc123.' },
    event('EVT-002', '2026-07-30T14:52:00Z', 'run_pull_request_opened', 'Opened pull request for sprint/x.'),
  ])
  assert.deepEqual(
    undated.map((item) => item.key),
    ['event:EVT-001'],
    'an undated commit still shows, but claims no pull request',
  )
}

{
  const beforeItsWork = buildTaskTimeline(task({ activity: [] }), [
    event('EVT-001', '2026-07-30T12:00:00Z', 'run_pull_request_opened', 'Opened pull request for sprint/x.'),
    event('EVT-002', '2026-07-30T14:40:00Z', 'task_changes_committed', 'developer-1 committed Sprint Engine changes for T2: abc123.'),
  ])
  assert.deepEqual(
    beforeItsWork.map((item) => item.key),
    ['event:EVT-002'],
    'a pull request opened before the task committed anything cannot carry its work',
  )
}

/* ---- glyphs ----------------------------------------------------------- */

{
  const lifecycleOf = (entry: SprintEngineTaskActivityEntry) =>
    timelineItemLifecycle({ key: entry.id, timestamp: entry.timestamp, kind: 'activity', entry })

  // Every kind the acceptance names is distinguishable by shape, and so is each
  // status a status_change can carry — a publish emits the status change and the
  // review pass back to back, so those two above all must not look alike.
  const seen = new Map<string, string>()
  for (const [label, entry] of [
    ['comment', activity('a', 't', 'comment')],
    ['claim', activity('b', 't', 'claim')],
    ['evidence', activity('c', 't', 'evidence')],
    ['review pass', activity('d', 't', 'feedback')],
    ['needs input', activity('e', 't', 'needs_input')],
    ['published for review', activity('f', 't', 'status_change', { status: 'review' })],
    ['completed', activity('g', 't', 'status_change', { status: 'done' })],
    ['resumed', activity('h', 't', 'status_change', { status: 'in_progress' })],
  ] as Array<[string, SprintEngineTaskActivityEntry]>) {
    const state = lifecycleOf(entry)
    assert.ok(!seen.has(state), `${label} shares a glyph with ${seen.get(state)}`)
    seen.set(state, label)
  }

  assert.equal(
    timelineItemLifecycle({
      key: 'k',
      timestamp: 't',
      kind: 'vcs',
      vcs: 'pr_merged',
      event: event('EVT-1', 't', 'run_pull_request_merged', ''),
    }),
    'done_merged',
    'a merged pull request reads as the merged branch mark',
  )
  assert.equal(
    timelineItemLifecycle({
      key: 'k',
      timestamp: 't',
      kind: 'vcs',
      vcs: 'committed',
      event: event('EVT-1', 't', 'task_changes_committed', ''),
    }),
    'done_unmerged',
  )
}

console.log('sprintEngineInspector task-detail read model tests passed')
