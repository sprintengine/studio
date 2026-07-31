import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildSprintEngineEpicModel,
  sprintEngineEpicMappingFor,
  sprintEngineEpicSeed,
  sprintEngineProjectRootFromStatePath,
  sprintEngineTaskMappingLabel,
} from './sprintEngineEpicModel'
import type { BacklogItem } from '../../../utils/backlog'
import type {
  SprintEngineSource,
  SprintEngineSourceBundleStateItem,
  SprintEngineTask,
} from '../../../types/workspace'

// Item 2028 (the Epic tab). The read model is proven directly here — seed
// detection, membership, the mapping column, ordering, and the unavailable
// states. The React-coupled rules (one chrome row, no divider under the heading,
// borderless rows, one focused selection) are measured on the RENDERED surface,
// not asserted from source; the source contracts pinned at the end of this file
// cover only the wiring a rendered pass cannot see (which components are reused,
// and that no second scan is opened).

function item(overrides: Partial<BacklogItem> & { relativePath: string }): BacklogItem {
  return {
    id: overrides.relativePath,
    objectId: `obj-${overrides.relativePath}`,
    path: `/project/${overrides.relativePath}`,
    title: overrides.relativePath,
    kind: 'generic_context',
    status: 'ready',
    isEpic: false,
    metadata: {},
    links: [],
    excerpt: '',
    modifiedAt: 0,
    createdAtMs: 0,
    size: 0,
    sourceContent: '',
    ...overrides,
  }
}

function task(overrides: Partial<SprintEngineTask> & { id: string }): SprintEngineTask {
  return {
    title: overrides.id,
    role: 'developer',
    repo: 'primary',
    status: 'todo',
    ownerAgentId: null,
    dependsOn: [],
    ownedPaths: [],
    acceptanceCriteria: [],
    implementationNotes: [],
    evidence: { summary: '', touchedFiles: [] },
    notes: [],
    comments: [],
    startedAt: null,
    completedAt: null,
    ...overrides,
  }
}

function epicSource(overrides: Partial<SprintEngineSource> = {}): SprintEngineSource {
  return {
    kind: 'markdown',
    origin: 'reference',
    path: 'backlog/epics/checkout-hardening.md',
    planKind: 'epic',
    ...overrides,
  }
}

function bundleChild(path: string): SprintEngineSourceBundleStateItem {
  return { kind: 'generic_context', origin: 'reference', path }
}

// ── 1. The seed: present only for an epic launch ────────────────────────────

assert.equal(
  sprintEngineEpicSeed({ kind: 'markdown', origin: 'copy', path: 'run/goal.md' }, []),
  null,
  'a goal-seeded run has no epic seed (and therefore no Epic section)',
)
assert.equal(
  sprintEngineEpicSeed({ kind: 'markdown', origin: 'reference', path: 'backlog/2026-07-01-one-item.md' }, []),
  null,
  'a single backlog item is not an epic launch',
)
assert.equal(
  sprintEngineEpicSeed(epicSource({ path: 'run/seed/epic.md', originalPath: undefined }), []),
  null,
  'an epic copied into the run store with no recorded original cannot be located in backlog/',
)
// A run created from the Backlog surface / MCP records planKind `unknown` even
// when it points straight at an epic file, so the file's location has to count.
assert.ok(
  sprintEngineEpicSeed(epicSource({ planKind: 'unknown' }), []),
  'an epic file with no epic planKind is still an epic launch',
)
assert.ok(
  sprintEngineEpicSeed(
    { kind: 'markdown', origin: 'copy', path: 'run/seed/epic.md', originalPath: 'backlog/epics/checkout-hardening.md' },
    [],
  ),
  'a copied seed is located through its recorded original',
)

const seed = sprintEngineEpicSeed(epicSource(), [
  bundleChild('backlog/2026-07-01-idempotency.md'),
  bundleChild('backlog/2026-07-02-retries.md'),
  bundleChild('docs/context.md'),
  bundleChild('backlog/epics/checkout-hardening.md'),
])
assert.ok(seed, 'an epic launch yields a seed')
assert.equal(seed.slug, 'checkout-hardening', 'slug is the epic file stem')
assert.deepEqual(
  seed.recordedChildPaths,
  ['backlog/2026-07-01-idempotency.md', 'backlog/2026-07-02-retries.md'],
  'recorded members are the bundle’s backlog items — never a supporting file, never the epic itself',
)

// ── 1b. The project a door-mounted run reads its backlog from ───────────────

assert.equal(
  sprintEngineProjectRootFromStatePath('/Users/me/work/app/.multi-code/sprintengine/checkout/run.yaml'),
  '/Users/me/work/app',
  'a run store names the project it lives in',
)
assert.equal(
  sprintEngineProjectRootFromStatePath('C:\\work\\App\\.Multi-Code\\SprintEngine\\checkout\\run.yaml'),
  'C:\\work\\App',
  'separators and case do not change the answer',
)
assert.equal(
  sprintEngineProjectRootFromStatePath('/Users/me/work/app/run.yaml'),
  null,
  'a path that is not a run store yields no project rather than a guess',
)
assert.equal(sprintEngineProjectRootFromStatePath(null), null)

// ── 2. The mapping column ───────────────────────────────────────────────────

assert.equal(sprintEngineTaskMappingLabel('T4'), 'task 4', 'engine task ids read as an ordinal')
assert.equal(sprintEngineTaskMappingLabel('T12'), 'task 12')
assert.equal(sprintEngineTaskMappingLabel('review-pass'), 'review-pass', 'a non-engine id is verbatim')

const mapped = sprintEngineEpicMappingFor(
  [
    task({ id: 'T1', backlogRef: { projectRelativePath: 'backlog/a.md' } }),
    task({
      id: 'T2',
      backlogRef: { projectRelativePath: 'backlog\\B.MD' },
      ownerAgentId: null,
      lastImplementedByAgentId: 'developer-2',
    }),
  ],
  'backlog/b.md',
)
assert.deepEqual(
  mapped,
  { taskId: 'T2', label: 'task 2', agentId: 'developer-2' },
  'the pointer matches case- and separator-insensitively; the last implementer stays visible in review',
)

// ── 3. The list ─────────────────────────────────────────────────────────────

const children = [
  item({ relativePath: 'backlog/2026-07-02-retries.md', epic: 'checkout-hardening', status: 'in_progress' }),
  item({ relativePath: 'backlog/2026-07-01-idempotency.md', epic: 'checkout-hardening', status: 'completed' }),
  // Added to the epic after the sprint started — no task points at it yet.
  item({ relativePath: 'backlog/2026-07-09-decline-codes.md', epic: 'checkout-hardening' }),
  // Another epic's member, and a loose item: neither belongs to this view.
  item({ relativePath: 'backlog/2026-07-03-relay.md', epic: 'relay-cutover' }),
  item({ relativePath: 'backlog/2026-07-04-loose.md' }),
]
const epicItem = item({
  relativePath: 'backlog/epics/checkout-hardening.md',
  title: 'Checkout hardening',
  isEpic: true,
  type: 'epic',
  displayId: 'MC-1841',
})
const tasks = [
  task({ id: 'T1', backlogRef: { projectRelativePath: 'backlog/2026-07-01-idempotency.md' }, ownerAgentId: 'developer-1' }),
  task({ id: 'T2', backlogRef: { projectRelativePath: 'backlog/2026-07-02-retries.md' }, ownerAgentId: 'developer-3' }),
  // A follow-up the coordinator filed mid-run: no backlog item behind it, so it
  // lives in Tasks and never appears here.
  task({ id: 'T3' }),
]

const model = buildSprintEngineEpicModel({
  seed,
  items: [epicItem, ...children],
  scanErrors: [],
  tasks,
})

assert.equal(model.epic?.displayId, 'MC-1841', 'the heading is the epic item from the scan')
assert.equal(model.epicUnavailableReason, null)
assert.deepEqual(
  model.rows.map((row) => `${row.relativePath}|${row.mapping?.label ?? ''}|${row.mapping?.agentId ?? ''}`),
  [
    'backlog/2026-07-01-idempotency.md|task 1|developer-1',
    'backlog/2026-07-02-retries.md|task 2|developer-3',
    // No task: the mapping cell is empty, and the row is neither an error nor
    // hidden.
    'backlog/2026-07-09-decline-codes.md||',
  ],
  'children only, ordered by the task delivering them, un-mapped last',
)
assert.deepEqual(model.progress, { done: 1, total: 3 }, 'completion is the shared full-scan rollup')

// ── 4. Unavailable files never shrink the list ──────────────────────────────

const movedChild = 'backlog/2026-07-02-retries.md'
const degraded = buildSprintEngineEpicModel({
  seed,
  items: [epicItem, ...children.filter((child) => child.relativePath !== movedChild)],
  scanErrors: [{ relativePath: movedChild, message: 'Unreadable frontmatter.' }],
  tasks,
})
const unavailable = degraded.rows.filter((row) => row.kind === 'unavailable')
assert.equal(unavailable.length, 1, 'the file the scan could not read is still a row')
assert.equal(unavailable[0].relativePath, movedChild, 'it carries its path')
assert.equal(
  unavailable[0].kind === 'unavailable' ? unavailable[0].reason : '',
  'Unreadable frontmatter.',
  'the scan’s own error is the reason',
)
assert.equal(unavailable[0].mapping?.label, 'task 2', 'its task mapping still reads')
assert.equal(degraded.rows.length, 3, 'the rest of the epic still renders')

const missingEpic = buildSprintEngineEpicModel({
  seed,
  items: children,
  scanErrors: [],
  tasks,
})
assert.equal(missingEpic.epic, null, 'a missing epic file leaves no item behind the heading')
assert.match(
  missingEpic.epicUnavailableReason ?? '',
  /moved or deleted/,
  'and says so rather than rendering an empty heading',
)
assert.equal(missingEpic.rows.length, 3, 'its children still render')

// A task pointing at a file that is not in the scan is a broken pointer, shown
// rather than silently dropped.
const danglingPointer = buildSprintEngineEpicModel({
  seed,
  items: [epicItem, ...children],
  scanErrors: [],
  tasks: [...tasks, task({ id: 'T4', backlogRef: { projectRelativePath: 'backlog/2026-07-11-gone.md' } })],
})
const dangling = danglingPointer.rows.find((row) => row.relativePath === 'backlog/2026-07-11-gone.md')
assert.ok(dangling && dangling.kind === 'unavailable', 'a pointer at nothing is visible')
assert.equal(dangling.mapping?.label, 'task 4')

// ── 5. Source contracts the rendered pass cannot see ────────────────────────

const here = join(process.cwd(), 'src/renderer/src/components/panels/sprintEngineBoard')
const viewSource = readFileSync(join(here, 'SprintEngineEpicView.tsx'), 'utf8')
const hookSource = readFileSync(join(here, 'useSprintEngineEpicBacklog.ts'), 'utf8')

assert.match(
  viewSource,
  /BacklogRowContent/,
  'children render through the Backlog row, never a fork of it',
)
assert.match(
  viewSource,
  /<BacklogItemDetailPane/,
  'the selected child renders through the shared Backlog detail pane',
)
assert.equal(
  /useSharedBacklogScan/.test(viewSource),
  false,
  'the view opens no scan of its own',
)
assert.equal(
  (hookSource.match(/useSharedBacklogScan\(/g) ?? []).length,
  1,
  'exactly one shared-scan subscription backs the whole surface',
)

console.log('SprintEngineEpicModel.test.ts: ok')
