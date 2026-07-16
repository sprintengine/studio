import assert from 'node:assert/strict'

import type { BacklogItem, BacklogItemLink } from './backlog'
import {
  hasSprintEngineRunLink,
  openSprintEngineBacklogLink,
  resolveSprintEngineBacklogLink,
  sprintEngineRunLinkForItem,
  SPRINT_ENGINE_RUN_TARGET_KIND,
} from './sprintengineBacklogLinks'
import type { Workspace } from '../types/workspace'

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

  const opened: string[] = []
  const diagnostics: string[] = []
  const mountedWorkspace = {
    id: 'ws-run',
    name: 'Run Workspace',
    folderPath: workspaceRoot,
    sprintEngineContext: {
      teamName: 'Team',
      teamSlug: 'team',
      teamDirectoryPath: '/repo/.multi-code/sprintengine/team',
      statePath: '/repo/.multi-code/sprintengine/team/run.yaml',
    },
  } as Workspace
  assert.equal(
    await openSprintEngineBacklogLink({
      workspaceId: 'ws-backlog',
      workspaceRoot,
      item: baseItem,
      link: baseLink,
      ports: {
        workspaces: [mountedWorkspace],
        setActiveWorkspace: (workspaceId) => opened.push(`active:${workspaceId}`),
        openRunSummaryOverlay: (workspaceId) => opened.push(`summary:${workspaceId}`),
      },
    }),
    true,
    'mounted run targets open successfully',
  )
  assert.deepEqual(opened, ['active:ws-run', 'summary:ws-run'])

  const recoveredOpened: string[] = []
  const recoveryCalls: Array<{ workspaceRoot: string; statePath: string; teamSlug: string }> = []
  const recoveredWorkspace = {
    ...mountedWorkspace,
    id: 'ws-recovered-run',
  } as Workspace
  assert.equal(
    await openSprintEngineBacklogLink({
      workspaceId: 'ws-backlog',
      workspaceRoot,
      item: baseItem,
      link: baseLink,
      ports: {
        workspaces: [],
        mountWorkspaceForRun: async (input) => {
          recoveryCalls.push({
            workspaceRoot: input.workspaceRoot,
            statePath: input.statePath,
            teamSlug: input.teamSlug,
          })
          return recoveredWorkspace
        },
        setActiveWorkspace: (workspaceId) => recoveredOpened.push(`active:${workspaceId}`),
        openRunSummaryOverlay: (workspaceId) => recoveredOpened.push(`summary:${workspaceId}`),
      },
    }),
    true,
    'unmounted run targets mount from the durable run link before opening',
  )
  assert.deepEqual(recoveryCalls, [{
    workspaceRoot,
    statePath: '/repo/.multi-code/sprintengine/team/run.yaml',
    teamSlug: 'team',
  }])
  assert.deepEqual(recoveredOpened, ['active:ws-recovered-run', 'summary:ws-recovered-run'])

  assert.equal(
    await openSprintEngineBacklogLink({
      workspaceId: 'ws-backlog',
      workspaceRoot,
      item: baseItem,
      link: baseLink,
      ports: {
        workspaces: [],
        setActiveWorkspace: () => opened.push('should-not-activate'),
        openRunSummaryOverlay: () => opened.push('should-not-open'),
        publishDiagnostic: (input) => diagnostics.push(input.message),
      },
    }),
    false,
    'unmounted run targets do not fake open success',
  )
  assert.match(diagnostics[0] ?? '', /No open workspace/)

  const invalidOpenCalls: string[] = []
  assert.equal(
    await openSprintEngineBacklogLink({
      workspaceId: 'ws-backlog',
      workspaceRoot,
      item: baseItem,
      link: linkWithTargetPath('/tmp/other/run.yaml'),
      ports: {
        workspaces: [{
          ...mountedWorkspace,
          id: 'outside',
          folderPath: '/tmp/other',
          sprintEngineContext: {
            teamName: 'Outside',
            teamSlug: 'other',
            teamDirectoryPath: '/tmp/other',
            statePath: '/tmp/other/run.yaml',
          },
        }],
        setActiveWorkspace: (workspaceId: string) => invalidOpenCalls.push(`active:${workspaceId}`),
        openRunSummaryOverlay: (workspaceId: string) => invalidOpenCalls.push(`summary:${workspaceId}`),
        publishDiagnostic: (input) => diagnostics.push(input.message),
      },
    }),
    false,
    'absolute persisted run targets do not open mounted external workspaces',
  )
  assert.deepEqual(invalidOpenCalls, [])
  assert.match(diagnostics.at(-1) ?? '', /project-relative Sprint Engine run target/)

  const invalidYmlOpenCalls: string[] = []
  assert.equal(
    await openSprintEngineBacklogLink({
      workspaceId: 'ws-backlog',
      workspaceRoot,
      item: baseItem,
      link: linkWithTargetPath('.multi-code/sprintengine/team/run.yml'),
      ports: {
        workspaces: [{
          ...mountedWorkspace,
          id: 'yml-run',
          sprintEngineContext: {
            ...mountedWorkspace.sprintEngineContext!,
            statePath: '/repo/.multi-code/sprintengine/team/run.yml',
          },
        }],
        setActiveWorkspace: (workspaceId: string) => invalidYmlOpenCalls.push(`active:${workspaceId}`),
        openRunSummaryOverlay: (workspaceId: string) => invalidYmlOpenCalls.push(`summary:${workspaceId}`),
        publishDiagnostic: (input) => diagnostics.push(input.message),
      },
    }),
    false,
    'persisted run.yml targets do not open mounted workspaces',
  )
  assert.deepEqual(invalidYmlOpenCalls, [])
  assert.match(diagnostics.at(-1) ?? '', /project-relative Sprint Engine run target/)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
