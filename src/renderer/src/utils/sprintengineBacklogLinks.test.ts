import assert from 'node:assert/strict'

import type { BacklogItem, BacklogItemLink } from './backlog'
import {
  buildSprintEngineRunLink,
  hasSprintEngineRunLink,
  isLandedSprintEngineRun,
  isSprintEngineChildRunLink,
  openSprintEngineBacklogLink,
  resolveSprintEngineBacklogLink,
  resolveSprintEngineChildRunLink,
  sprintEngineRunLinkForItem,
  SPRINT_ENGINE_RUN_TARGET_KIND,
} from './sprintengineBacklogLinks'
import { normalizeSprintEngineProjection } from './sprintengine'
import { runDoorForProjection } from '../components/workspace/globalSurface/sprints/runDoors'

const workspaceRoot = '/repo'

const baseLink: BacklogItemLink = {
  id: 'sprint-engine:run',
  moduleId: 'sprint-engine',
  type: 'execution',
  label: 'Sprint Engine run',
  target: {
    kind: SPRINT_ENGINE_RUN_TARGET_KIND,
    id: 'run',
    path: '.sprintengine/sprintengine/team/run.yaml',
  },
  status: 'active',
}

const baseItem: BacklogItem = {
  id: 'backlog/run.md',
  objectId: 'backlog_run',
  path: '/repo/backlog/run.md',
  relativePath: 'backlog/run.md',
  title: 'Run',
  kind: 'unknown',
  status: 'idea',
  isEpic: false,
  metadata: {},
  links: [],
  excerpt: '',
  modifiedAt: 1,
  createdAtMs: 1,
  size: 1,
  sourceContent: '# Run',
}

function linkWithTargetPath(path: string): BacklogItemLink {
  return { ...baseLink, target: { ...baseLink.target, path } }
}

function projection(taskStatuses: string[]): unknown {
  return {
    run: { name: 'Team', goal: 'Ship it' },
    roster: {},
    tasks: taskStatuses.map((status, index) => ({
      id: `T${index + 1}`,
      title: `Task ${index + 1}`,
      role: 'developer',
      status,
      dependsOn: [],
      ownedPaths: [],
      acceptanceCriteria: [],
      implementationNotes: [],
      evidence: {},
      notes: [],
      comments: [],
      startedAt: null,
      completedAt: status === 'done' ? '2026-06-09T00:00:00Z' : null,
    })),
    artifacts: [],
    activity: [],
  }
}

async function main(): Promise<void> {
  assert.equal(hasSprintEngineRunLink({ links: [baseLink] }), true)
  assert.equal(sprintEngineRunLinkForItem({ links: [baseLink] })?.target.path, baseLink.target.path)

  const completed = await resolveSprintEngineBacklogLink({
    workspaceId: 'ws-backlog',
    workspaceRoot,
    item: { ...baseItem, links: [baseLink] },
    link: baseLink,
    readSprintEngineProjection: async () => ({ ok: true, data: projection(['done', 'done']) }),
  })
  assert.equal(completed.status, 'completed', 'all done tasks complete the execution link')
  assert.equal(completed.canOpen, true)

  // A canceled run (stored flag, surfaced from run.status) reads as `canceled` —
  // outranking the done/canceled task rollup, which would otherwise misread it.
  const canceled = await resolveSprintEngineBacklogLink({
    workspaceId: 'ws-backlog',
    workspaceRoot,
    item: { ...baseItem, links: [baseLink] },
    link: baseLink,
    readSprintEngineProjection: async () => ({
      ok: true,
      data: { ...(projection(['done', 'canceled']) as object), run: { name: 'Team', goal: 'Ship it', status: 'canceled' } },
    }),
  })
  assert.equal(canceled.status, 'canceled', 'a canceled run reads as canceled, not completed')
  assert.equal(canceled.canOpen, true)

  const active = await resolveSprintEngineBacklogLink({
    workspaceId: 'ws-backlog',
    workspaceRoot,
    item: { ...baseItem, links: [baseLink] },
    link: baseLink,
    readSprintEngineProjection: async () => ({ ok: true, data: projection(['done', 'in_progress']) }),
  })
  assert.equal(active.status, 'active', 'readable nonterminal projections stay active')

  const noTasks = await resolveSprintEngineBacklogLink({
    workspaceId: 'ws-backlog',
    workspaceRoot,
    item: { ...baseItem, links: [baseLink] },
    link: baseLink,
    readSprintEngineProjection: async () => ({ ok: true, data: projection([]) }),
  })
  assert.equal(noTasks.status, 'active', 'empty readable projections are not completed')

  const missing = await resolveSprintEngineBacklogLink({
    workspaceId: 'ws-backlog',
    workspaceRoot,
    item: baseItem,
    link: baseLink,
    readSprintEngineProjection: async () => ({ ok: false, message: 'Missing run' }),
  })
  assert.equal(missing.status, 'unknown')
  assert.match(missing.unavailableReason ?? '', /Missing run/)

  const unreadable = await resolveSprintEngineBacklogLink({
    workspaceId: 'ws-backlog',
    workspaceRoot,
    item: baseItem,
    link: baseLink,
    readSprintEngineProjection: async () => {
      throw new Error('Permission denied')
    },
  })
  assert.equal(unreadable.status, 'unknown')
  assert.match(unreadable.unavailableReason ?? '', /Permission denied/)

  const malformed = await resolveSprintEngineBacklogLink({
    workspaceId: 'ws-backlog',
    workspaceRoot,
    item: baseItem,
    link: baseLink,
    readSprintEngineProjection: async () => ({ ok: true, data: 'not a projection' }),
  })
  assert.equal(malformed.status, 'unknown')
  assert.match(malformed.unavailableReason ?? '', /malformed/)

  for (const path of [
    '/tmp/other/run.yaml',
    'C:\\tmp\\other\\run.yaml',
    '\\\\server\\share\\run.yaml',
    '../.sprintengine/sprintengine/team/run.yaml',
    '.sprintengine/sprintengine/team/run.yml',
    '.sprintengine/sprintengine/team/notes.md',
    '.sprintengine/sprintengine/team/tasks/T1.json',
  ]) {
    let projectionReads = 0
    const invalid = await resolveSprintEngineBacklogLink({
      workspaceId: 'ws-backlog',
      workspaceRoot,
      item: baseItem,
      link: linkWithTargetPath(path),
      readSprintEngineProjection: async () => {
        projectionReads += 1
        return { ok: true, data: projection(['done']) }
      },
    })
    assert.equal(invalid.status, 'unknown', `${path} resolves as unavailable`)
    assert.equal(projectionReads, 0, `${path} does not read projections`)
    assert.match(invalid.unavailableReason ?? '', /project-relative run\.yaml target/)
  }

  // Opening a run link (item 1767): the door, on that run. No workspace is
  // looked up or mounted — the door reads runs from disk — so the only questions
  // left are which state path it was handed and what happens when the run cannot
  // be read.
  const doorOpens: string[] = []
  const diagnostics: string[] = []
  assert.equal(
    await openSprintEngineBacklogLink({
      workspaceId: 'ws-backlog',
      workspaceRoot,
      item: baseItem,
      link: baseLink,
      ports: {
        openSprintsDoorOnRun: (statePath) => {
          doorOpens.push(statePath)
          return true
        },
      },
    }),
    true,
    'a run link opens the Sprints door on its run',
  )
  assert.deepEqual(doorOpens, ['/repo/.sprintengine/sprintengine/team/run.yaml'])

  // WHICH door it opens (item 2470). The link's port reads the run's projection
  // before opening anything — it already has to, to prove the link still points
  // at something — and answers the door from that read. A link that named
  // "sprints" still resolves; it now resolves to the door the run is actually
  // listed in, because opening the other one shows a rail whose own partition
  // keeps the run out. This drives the same helper the port calls, on projections
  // normalized the same way, so the branch is exercised rather than assumed.
  for (const [configuredRoles, expected] of [
    [['architect', 'developer'], 'workflows'],
    [[], 'sprints'],
    [undefined, 'workflows'],
  ] as const) {
    const projection = normalizeSprintEngineProjection({
      run: { name: 'team', ...(configuredRoles ? { configuredRoles } : {}) },
      tasks: [],
      roster: {},
    })
    assert.equal(
      runDoorForProjection(projection),
      expected,
      `a run configured ${JSON.stringify(configuredRoles)} opens the ${expected} door`,
    )
  }
  // And a projection that would not normalize states no kind at all, so the link
  // takes the partition's own fallback rather than guessing at planning.
  assert.equal(runDoorForProjection(null), 'sprints', 'an unreadable run still opens a door')

  // A run whose store is gone reports it. Opening the door anyway would land the
  // operator on some unrelated sprint and call that success.
  assert.equal(
    await openSprintEngineBacklogLink({
      workspaceId: 'ws-backlog',
      workspaceRoot,
      item: baseItem,
      link: baseLink,
      ports: {
        openSprintsDoorOnRun: () => false,
        publishDiagnostic: (input) => diagnostics.push(input.message),
      },
    }),
    false,
    'an unreadable run does not fake open success',
  )
  assert.match(diagnostics[0] ?? '', /could not be read/)

  // Path validation still runs BEFORE the door is asked: an absolute or non-
  // run.yaml target never reaches it.
  for (const badPath of ['/tmp/other/run.yaml', '.sprintengine/sprintengine/team/run.yml']) {
    const rejectedOpens: string[] = []
    assert.equal(
      await openSprintEngineBacklogLink({
        workspaceId: 'ws-backlog',
        workspaceRoot,
        item: baseItem,
        link: linkWithTargetPath(badPath),
        ports: {
          openSprintsDoorOnRun: (statePath: string) => {
            rejectedOpens.push(statePath)
            return true
          },
          publishDiagnostic: (input) => diagnostics.push(input.message),
        },
      }),
      false,
      `${badPath} is not an openable run target`,
    )
    assert.deepEqual(rejectedOpens, [], `${badPath} never reaches the door`)
    assert.match(diagnostics.at(-1) ?? '', /project-relative sprint run target/)
  }

  testChildRunLinkResolution()
  await testChildLinkResolvesThroughTheProvider()
}

// ── MC-2017: a child item moves with its TASK, and lands with the SPRINT.

function childProjection(input: {
  tasks: Array<{ id: string; status: string; childPath?: string }>
  canceled?: boolean
  vcs?: unknown
}): ReturnType<typeof normalizeSprintEngineProjection> {
  return normalizeSprintEngineProjection({
    run: {
      name: 'Team',
      goal: 'Ship it',
      ...(input.canceled ? { status: 'canceled' } : {}),
      ...(input.vcs ? { vcs: input.vcs } : {}),
    },
    roster: {},
    tasks: input.tasks.map((task) => ({
      id: task.id,
      title: task.id,
      role: 'developer',
      status: task.status,
      dependsOn: [],
      ...(task.childPath ? { backlogRef: { projectRelativePath: task.childPath } } : {}),
    })),
    artifacts: [],
    activity: [],
  }, 'team')
}

function worktreeVcs(...pullRequestStates: Array<'open' | 'merged'>): unknown {
  return {
    mode: 'run_worktree',
    worktreePath: '/repo/.worktrees/team',
    branchName: 'sprint/team',
    repos: pullRequestStates.map((pullRequestState, index) => ({
      id: index === 0 ? 'primary' : `repo-${index}`,
      root: index === 0 ? '.' : `../repo-${index}`,
      worktreePath: `/repo/.worktrees/team-${index}`,
      branchName: 'sprint/team',
      lastCommitSha: 'abc123',
      pullRequestUrl: 'https://example.test/pr',
      pullRequestState,
    })),
  }
}

const childLink = buildSprintEngineRunLink({
  teamSlug: 'team',
  runRelativePath: '.sprintengine/sprintengine/team/run.yaml',
  status: 'pending',
  priorStatus: 'ready',
})

function testChildRunLinkResolution(): void {
  assert.equal(isSprintEngineChildRunLink(childLink), true, 'a pending run link is a child link')
  assert.equal(
    isSprintEngineChildRunLink(buildSprintEngineRunLink({ teamSlug: 'team', runRelativePath: 'x' })),
    false,
    'the launching item’s own run link is not a child link',
  )

  const resolve = (state: ReturnType<typeof normalizeSprintEngineProjection>) =>
    resolveSprintEngineChildRunLink({ state: state!, link: childLink, itemRelativePath: 'backlog/child.md' })

  // Before the planner mints the child's task there is nothing to claim it.
  assert.deepEqual(
    resolve(childProjection({ tasks: [{ id: 'T1', status: 'in_progress' }] })),
    { status: 'pending' },
    'a child whose task does not exist yet stays pending — another task claiming does not move it',
  )

  // The task is bound by backlogRef, and only ITS status counts.
  assert.deepEqual(
    resolve(childProjection({
      tasks: [
        { id: 'T1', status: 'in_progress' },
        { id: 'T2', status: 'todo', childPath: 'backlog/child.md' },
      ],
    })),
    { status: 'pending', taskId: 'T2' },
    'a minted but unclaimed task binds the link and leaves it pending',
  )
  assert.deepEqual(
    resolve(childProjection({ tasks: [{ id: 'T2', status: 'in_progress', childPath: 'backlog/child.md' }] })),
    { status: 'active', taskId: 'T2' },
    'the child goes active when its own task claims',
  )
  // The engine's review phase is how the sprint runs, not a human review gate.
  assert.deepEqual(
    resolve(childProjection({ tasks: [{ id: 'T2', status: 'review', childPath: 'backlog/child.md' }] })),
    { status: 'active', taskId: 'T2' },
    'a task in the engine review phase leaves its child reading as working',
  )

  // Landing, not task-done, is what completes a child.
  assert.equal(
    resolve(childProjection({
      tasks: [{ id: 'T2', status: 'done', childPath: 'backlog/child.md' }],
      vcs: worktreeVcs('open'),
    })).status,
    'active',
    'a done task on an unmerged branch is still only in flight',
  )
  assert.equal(
    resolve(childProjection({
      tasks: [{ id: 'T2', status: 'done', childPath: 'backlog/child.md' }],
      vcs: worktreeVcs('merged'),
    })).status,
    'completed',
    'merging the pull request lands the child',
  )
  assert.equal(
    resolve(childProjection({
      tasks: [{ id: 'T2', status: 'done', childPath: 'backlog/child.md' }],
      vcs: worktreeVcs('merged', 'open'),
    })).status,
    'active',
    'one project still unmerged holds every child of the run back',
  )
  assert.equal(
    resolve(childProjection({ tasks: [{ id: 'T2', status: 'done', childPath: 'backlog/child.md' }] })).status,
    'completed',
    'a run with no branch to merge lands on completion',
  )

  // Abandonment, at either grain.
  assert.equal(
    resolve(childProjection({ tasks: [{ id: 'T2', status: 'canceled', childPath: 'backlog/child.md' }] })).status,
    'canceled',
    'a canceled task abandons its child',
  )
  assert.equal(
    resolve(childProjection({
      tasks: [{ id: 'T2', status: 'in_progress', childPath: 'backlog/child.md' }],
      canceled: true,
    })).status,
    'canceled',
    'a canceled run abandons every child at once',
  )

  // The landed predicate itself, on the cases the child rules lean on.
  assert.equal(
    isLandedSprintEngineRun(childProjection({ tasks: [{ id: 'T1', status: 'in_progress' }] })!),
    false,
    'an unfinished run has not landed',
  )
  assert.equal(
    isLandedSprintEngineRun(childProjection({ tasks: [{ id: 'T1', status: 'done' }], canceled: true })!),
    false,
    'a canceled run never lands',
  )
}

// The Backlog surface resolves links through the provider on every read. It must
// apply the same per-task rules, or its sync pass would overwrite a child's
// status with the run-level one and move it the moment the sprint started.
async function testChildLinkResolvesThroughTheProvider(): Promise<void> {
  const resolved = await resolveSprintEngineBacklogLink({
    workspaceId: 'ws-backlog',
    workspaceRoot,
    item: { ...baseItem, relativePath: 'backlog/child.md', links: [childLink] },
    link: childLink,
    readSprintEngineProjection: async () => ({
      ok: true,
      data: {
        run: { name: 'Team', goal: 'Ship it' },
        roster: {},
        tasks: [
          { id: 'T1', title: 'Other', role: 'developer', status: 'in_progress', dependsOn: [] },
          {
            id: 'T2',
            title: 'Child',
            role: 'developer',
            status: 'todo',
            dependsOn: [],
            backlogRef: { projectRelativePath: 'backlog/child.md' },
          },
        ],
        artifacts: [],
        activity: [],
      },
    }),
  })
  assert.equal(resolved.status, 'pending', 'a live run does not make an unclaimed child read as active')
  assert.equal(resolved.target.taskId, 'T2', 'resolving binds the child to its task')
  assert.equal(resolved.canOpen, true, 'a child link still opens its sprint')
}

main()
  .then(() => console.log('sprintengineBacklogLinks tests passed'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
