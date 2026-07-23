import assert from 'node:assert/strict'

import type { BacklogItem, BacklogItemLink } from './backlog'
import {
  hasSprintEngineRunLink,
  openSprintEngineBacklogLink,
  resolveSprintEngineBacklogLink,
  sprintEngineRunLinkForItem,
  SPRINT_ENGINE_RUN_TARGET_KIND,
} from './sprintengineBacklogLinks'

const workspaceRoot = '/repo'

const baseLink: BacklogItemLink = {
  id: 'sprint-engine:run',
  moduleId: 'sprint-engine',
  type: 'execution',
  label: 'Sprint Engine run',
  target: {
    kind: SPRINT_ENGINE_RUN_TARGET_KIND,
    id: 'run',
    path: '.multi-code/sprintengine/team/run.yaml',
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
    '../.multi-code/sprintengine/team/run.yaml',
    '.multi-code/sprintengine/team/run.yml',
    '.multi-code/sprintengine/team/notes.md',
    '.multi-code/sprintengine/team/tasks/T1.json',
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
  assert.deepEqual(doorOpens, ['/repo/.multi-code/sprintengine/team/run.yaml'])

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
  for (const badPath of ['/tmp/other/run.yaml', '.multi-code/sprintengine/team/run.yml']) {
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
}

main()
  .then(() => console.log('sprintengineBacklogLinks tests passed'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
