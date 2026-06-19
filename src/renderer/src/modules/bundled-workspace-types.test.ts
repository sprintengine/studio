import assert from 'node:assert/strict'

import { getRendererHost } from './index'
import { createAutomationsTemplate } from './automations-workspace-types'
import { createMultiloopTemplate } from './multiloop-workspace-types'
import { createGuidedBriefTemplate, createSprintEngineTemplate } from './sprint-engine-workspace-types'
import { createSwitchboardTemplate } from './switchboard-workspace-types'
import { collectWorkspaceTypeSupervisors } from './workspace-type-supervisors'
import { decodeRunRef, handleAutomationRunEvent, resolveAutomationsWorkspaceId, scheduledRunNotification } from '../components/automations/runTarget'
import type { DiagnosticLogInput } from '../types/workspace'
import type { AutomationsRunEvent } from '../../../shared/automations/contracts'
import type { LayoutTemplate, SprintEngineMockConfig } from '../types/workspace'

const sprintEngineConfig: SprintEngineMockConfig = {
  name: 'Sprint Engine',
  goal: '',
  roleCounts: {} as SprintEngineMockConfig['roleCounts'],
}

const expectedTemplates: Record<string, LayoutTemplate> = {
  sprintengine: {
    id: 'sprintengine-mode',
    name: 'SprintEngine Mode',
    description: 'Inbox, Roster, and Tasks together in one stable board.',
    previewSlots: [
      { label: 'Sprint Engine', x: 4, y: 4, w: 292, h: 102, type: 'editor' },
    ],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            children: [
              { type: 'tab', name: 'Sprint Engine', component: 'sprintengine', enableClose: false },
            ],
          },
        ],
      },
    },
  },
  'guided-brief': {
    id: 'guided-brief-mode',
    name: 'Guided Brief',
    description: 'Product brief, mockups, and build handoff before implementation.',
    previewSlots: [
      { label: 'Brief', x: 4, y: 4, w: 140, h: 102, type: 'editor' },
      { label: 'Strategist', x: 148, y: 4, w: 148, h: 48, type: 'agent' },
      { label: 'Mockup', x: 148, y: 58, w: 148, h: 48, type: 'editor' },
    ],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            enableTabStrip: false,
            children: [
              { type: 'tab', name: 'Guided Brief', component: 'guided-brief', enableClose: false },
            ],
          },
        ],
      },
    },
  },
  switchboard: {
    id: 'switchboard-mode',
    name: 'Switchboard Mode',
    description: 'Watchtower triage inbox and the durable Switchboard task board.',
    previewSlots: [
      { label: 'Switchboard', x: 4, y: 4, w: 292, h: 102, type: 'editor' },
    ],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            enableTabStrip: false,
            children: [
              { type: 'tab', name: 'Switchboard', component: 'switchboard-workspace', enableClose: false },
            ],
          },
        ],
      },
    },
  },
  multiloop: {
    id: 'multiloop-mode',
    name: 'Multiloop Mode',
    description: 'Milestone roadmap, active work, blockers, and evidence.',
    previewSlots: [
      { label: 'Goal', x: 4, y: 4, w: 292, h: 22, type: 'editor' },
      { label: 'Roadmap', x: 4, y: 30, w: 92, h: 76, type: 'editor' },
      { label: 'Active Milestone', x: 100, y: 30, w: 196, h: 76, type: 'editor' },
    ],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            children: [
              { type: 'tab', name: 'Multiloop', component: 'multiloop-board' },
            ],
          },
        ],
      },
    },
  },
  automations: {
    id: 'automations-mode',
    name: 'Automations Mode',
    description: 'Schedule agents on this project, watch run history, and manage triggers.',
    previewSlots: [
      { label: 'Automations', x: 4, y: 4, w: 292, h: 102, type: 'editor' },
    ],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            enableTabStrip: false,
            children: [
              { type: 'tab', name: 'Automations', component: 'automations-control-center', enableClose: false },
            ],
          },
        ],
      },
    },
  },
}

assert.deepEqual(createSprintEngineTemplate(sprintEngineConfig), expectedTemplates.sprintengine)
assert.deepEqual(createGuidedBriefTemplate(), expectedTemplates['guided-brief'])
assert.deepEqual(createSwitchboardTemplate(), expectedTemplates.switchboard)
assert.deepEqual(createMultiloopTemplate(), expectedTemplates.multiloop)
assert.deepEqual(createAutomationsTemplate(), expectedTemplates.automations)

const host = getRendererHost()

assert.deepEqual(
  host.getWorkspaceTypes().map((definition) => definition.id),
  ['switchboard', 'sprintengine', 'multiloop', 'automations', 'guided-brief'],
  'bundled workspace types keep the existing picker order',
)
assert.deepEqual(
  host.getWorkspaceTypes((moduleId) => moduleId !== 'sprint-engine').map((definition) => definition.id),
  ['switchboard', 'multiloop', 'automations'],
  'sprint-engine disablement hides sprintengine and dependent guided-brief',
)
assert.deepEqual(
  host.getWorkspaceTypes((moduleId) => moduleId !== 'automations').map((definition) => definition.id),
  ['switchboard', 'sprintengine', 'multiloop', 'guided-brief'],
  'automations disablement hides only the automations workspace type',
)
assert.deepEqual(
  host.getWorkspaceTypes((moduleId) => moduleId !== 'sprint-engine')
    .flatMap((definition) => definition.supervisors ?? [])
    .map((supervisor) => supervisor.scope),
  ['global', 'global'],
  'workspace-type supervisor listings are gated by module enablement',
)

assert.equal(host.getWorkspaceTypeModule('sprintengine'), 'sprint-engine')
assert.equal(host.getWorkspaceTypeModule('guided-brief'), 'sprint-engine')
assert.equal(host.getWorkspaceTypeModule('switchboard'), 'switchboard')
assert.equal(host.getWorkspaceTypeModule('multiloop'), 'multiloop')
assert.equal(host.getWorkspaceTypeModule('automations'), 'automations')

assert.deepEqual(
  ['switchboard', 'sprintengine', 'multiloop', 'automations', 'guided-brief'].map((id) => {
    const definition = host.getWorkspaceType(id)
    assert.ok(definition, `expected ${id} registration`)
    return {
      id: definition.id,
      moduleId: definition.moduleId,
      label: definition.label,
      description: definition.description,
      accentToken: definition.accentToken,
      creationStepsId: definition.creationStepsId,
    }
  }),
  [
    {
      id: 'switchboard',
      moduleId: 'switchboard',
      label: 'Switchboard',
      description: 'Triage board and Watchtower review, fed by agent-created inbox tasks.',
      accentToken: '--tool-switchboard',
      creationStepsId: 'switchboard',
    },
    {
      id: 'sprintengine',
      moduleId: 'sprint-engine',
      label: 'Sprint Engine',
      description: 'Specialist roster, architect plan, kanban, and evidence trail.',
      accentToken: '--tool-sprintengine',
      creationStepsId: 'sprintengine',
    },
    {
      id: 'multiloop',
      moduleId: 'multiloop',
      label: 'Multiloop',
      description: 'Roadmap, milestones, decisions, and evidence for long-running work.',
      accentToken: '--text-muted',
      creationStepsId: 'multiloop',
    },
    {
      id: 'automations',
      moduleId: 'automations',
      label: 'Automations',
      description: 'Schedule agents and tasks on this project, with run history and per-project control.',
      accentToken: '--accent-primary',
      creationStepsId: 'automations',
    },
    {
      id: 'guided-brief',
      moduleId: 'sprint-engine',
      label: 'Guided brief',
      description: 'Answer questions. We produce a brief, screens, and a build handoff before any code starts.',
      accentToken: '--accent-primary',
      creationStepsId: 'guided-brief',
    },
  ],
  'registered metadata matches the existing mode picker and top-bar copy',
)

for (const [id, expectedTemplate] of Object.entries(expectedTemplates)) {
  assert.deepEqual(host.getWorkspaceType(id)?.createTemplate(), expectedTemplate, `${id} template stays unchanged`)
}

assert.deepEqual(
  host.getWorkspaceType('sprintengine')?.supervisors?.map((supervisor) => ({
    scope: supervisor.scope,
    hasComponent: Boolean(supervisor.Component),
  })),
  [
    { scope: 'global', hasComponent: true },
  ],
  'Sprint Engine owns its global auto-run supervisor contribution',
)
assert.deepEqual(
  host.getWorkspaceType('multiloop')?.supervisors?.map((supervisor) => ({
    scope: supervisor.scope,
    hasComponent: Boolean(supervisor.Component),
  })),
  [
    { scope: 'global', hasComponent: true },
  ],
  'Multiloop owns its global auto-run supervisor contribution',
)
assert.deepEqual(
  host.getWorkspaceType('automations')?.supervisors?.map((supervisor) => ({
    scope: supervisor.scope,
    hasComponent: Boolean(supervisor.Component),
  })),
  [
    { scope: 'global', hasComponent: true },
  ],
  'Automations owns its global background-run observer contribution',
)
assert.deepEqual(
  collectWorkspaceTypeSupervisors(host.getWorkspaceTypes(), true).map((supervisor) => supervisor.key),
  ['sprintengine:global:0', 'multiloop:global:0', 'automations:global:0'],
  'primary workspace window mounts global supervisor contributions in registry order',
)
assert.deepEqual(
  collectWorkspaceTypeSupervisors(host.getWorkspaceTypes(), false).map((supervisor) => supervisor.key),
  [],
  'secondary workspace windows do not mount global supervisor contributions',
)
assert.deepEqual(
  collectWorkspaceTypeSupervisors(
    host.getWorkspaceTypes((moduleId) => moduleId !== 'sprint-engine'),
    true,
  ).map((supervisor) => supervisor.key),
  ['multiloop:global:0', 'automations:global:0'],
  'disabling a module removes its supervisor contribution without affecting others',
)

// T13 regression: a background (timer) run notification's Open must land in the
// project's automations control center even when only a standard workspace is
// open. resolveAutomationsWorkspaceId dedupes to an existing automations
// workspace for the folder, else creates one; with no folder it falls back.
{
  const standardOnly = [
    { id: 'ws-standard', mode: 'standard', folderPath: '/repo/app' },
  ]
  let created: { folderPath: string } | null = null
  const resolvedCreate = resolveAutomationsWorkspaceId({
    folderPath: '/repo/app',
    fallbackWorkspaceId: 'ws-standard',
    workspaces: standardOnly,
    createAutomationsWorkspace: (folderPath) => {
      created = { folderPath }
      return 'ws-automations-new'
    },
  })
  assert.equal(resolvedCreate, 'ws-automations-new', 'creates an automations workspace when none exists for the folder')
  assert.deepEqual(created, { folderPath: '/repo/app' }, 'creates it for the run folder')

  const withAutomations = [
    ...standardOnly,
    { id: 'ws-automations', mode: 'automations', folderPath: '/repo/app' },
  ]
  const resolvedExisting = resolveAutomationsWorkspaceId({
    folderPath: '/repo/app',
    fallbackWorkspaceId: 'ws-standard',
    workspaces: withAutomations,
    createAutomationsWorkspace: () => assert.fail('must not create when an automations workspace already exists'),
  })
  assert.equal(resolvedExisting, 'ws-automations', 'dedupes to the existing automations workspace for the folder')

  const resolvedNoFolder = resolveAutomationsWorkspaceId({
    folderPath: null,
    fallbackWorkspaceId: 'ws-standard',
    workspaces: withAutomations,
    createAutomationsWorkspace: () => assert.fail('must not create without a folder'),
  })
  assert.equal(resolvedNoFolder, 'ws-standard', 'falls back to the notification workspace when no folder is known')
}

// T13 regression: the always-mounted observer's per-event decision. A timer
// failed/blocked run yields a source-'automations' notification with a run
// deep-link; manual events (owned by T6) and non-terminal/completed states are
// ignored. Proves the handle->notify path independent of lazy mount timing.
{
  const baseEvent: AutomationsRunEvent = {
    automationId: 'auto-1',
    runId: 'run-9',
    workspaceId: 'ws-project',
    definitionName: 'Nightly QA',
    status: 'failed',
    trigger: 'timer',
  }
  const failed = scheduledRunNotification(baseEvent, () => '/repo/app')
  assert.ok(failed, 'timer failed run raises a notification')
  assert.equal(failed.source, 'automations', 'notification is source-automations')
  assert.equal(failed.level, 'error', 'failed run is error severity')
  assert.equal(failed.workspaceId, 'ws-project')
  assert.equal(failed.navigationTarget?.kind, 'run', 'carries a run deep-link target')
  assert.deepEqual(
    decodeRunRef(failed.navigationTarget!.ref),
    { automationId: 'auto-1', runId: 'run-9', folderPath: '/repo/app' },
    'deep-link ref carries automation, run, and folder for resolve/create',
  )

  const blocked = scheduledRunNotification({ ...baseEvent, status: 'blocked' }, () => '/repo/app')
  assert.equal(blocked?.level, 'warning', 'blocked run is warning severity')

  assert.equal(
    scheduledRunNotification({ ...baseEvent, trigger: 'manual' }, () => '/repo/app'),
    null,
    'manual runs are ignored (owned by T6, no double-toast)',
  )
  assert.equal(
    scheduledRunNotification({ ...baseEvent, status: 'completed' }, () => '/repo/app'),
    null,
    'completed runs stay silent (low-noise)',
  )
}

// T13 C7/C9/C10: the observer's delivered-event -> publish boundary (the path
// that failed in built Electron). handleAutomationRunEvent is what the mounted
// supervisor invokes for every onAutomationRunEvent payload.
{
  const event: AutomationsRunEvent = {
    automationId: 'auto-2',
    runId: 'run-42',
    workspaceId: 'ws-project',
    definitionName: 'Nightly QA',
    status: 'failed',
    trigger: 'timer',
  }
  const resolveFolderPath = (workspaceId: string) => (workspaceId === 'ws-project' ? '/repo/app' : null)

  const published: DiagnosticLogInput[] = []
  handleAutomationRunEvent(event, resolveFolderPath, (input) => published.push(input))
  assert.equal(published.length, 1, 'timer failed event publishes exactly one notification')
  assert.equal(published[0].source, 'automations')
  assert.equal(published[0].level, 'error')
  assert.deepEqual(
    decodeRunRef(published[0].navigationTarget!.ref),
    { automationId: 'auto-2', runId: 'run-42', folderPath: '/repo/app' },
    'published deep-link resolves the run folder for Open',
  )

  const manualPublished: DiagnosticLogInput[] = []
  handleAutomationRunEvent({ ...event, trigger: 'manual' }, resolveFolderPath, (input) => manualPublished.push(input))
  assert.equal(manualPublished.length, 0, 'manual events publish nothing (owned by T6)')

  const completedPublished: DiagnosticLogInput[] = []
  handleAutomationRunEvent({ ...event, status: 'completed' }, resolveFolderPath, (input) => completedPublished.push(input))
  assert.equal(completedPublished.length, 0, 'completed events publish nothing (low-noise)')
}

console.log('bundled workspace type registration tests passed')
