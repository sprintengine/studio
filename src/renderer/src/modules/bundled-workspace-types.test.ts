import assert from 'node:assert/strict'

import { getRendererHost } from './index'
import { createMultiloopTemplate } from './multiloop-workspace-types'
import { createGuidedBriefTemplate, createSprintEngineTemplate } from './sprint-engine-workspace-types'
import { createSwitchboardTemplate } from './switchboard-workspace-types'
import { collectWorkspaceTypeSupervisors } from './workspace-type-supervisors'
import {
  decodeRunRef,
  handleAutomationRunEvent,
  scheduledRunNotification,
  subscribeAutomationRunNotifications,
  type AutomationRunEventSource,
} from '../components/automations/runTarget'
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
    name: 'Design Wizard',
    description: 'Plan, mockups, and build handoff before implementation.',
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
              { type: 'tab', name: 'Design Wizard', component: 'guided-brief', enableClose: false },
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
}

assert.deepEqual(createSprintEngineTemplate(sprintEngineConfig), expectedTemplates.sprintengine)
assert.deepEqual(createGuidedBriefTemplate(), expectedTemplates['guided-brief'])
assert.deepEqual(createSwitchboardTemplate(), expectedTemplates.switchboard)
assert.deepEqual(createMultiloopTemplate(), expectedTemplates.multiloop)

const host = getRendererHost()

assert.deepEqual(
  host.getWorkspaceTypes().map((definition) => definition.id),
  ['switchboard', 'sprintengine', 'multiloop', 'guided-brief'],
  'bundled workspace types keep the existing picker order (automations is a screen, not a type)',
)
assert.deepEqual(
  host.getWorkspaceTypes((moduleId) => moduleId !== 'sprint-engine').map((definition) => definition.id),
  ['switchboard', 'multiloop'],
  'sprint-engine disablement hides sprintengine and dependent guided-brief',
)
assert.deepEqual(
  host.getWorkspaceTypes((moduleId) => moduleId !== 'automations').map((definition) => definition.id),
  ['switchboard', 'sprintengine', 'multiloop', 'guided-brief'],
  'automations registers no workspace type, so disabling its module leaves the picker unchanged',
)
assert.deepEqual(
  host.getWorkspaceTypes((moduleId) => moduleId !== 'sprint-engine')
    .flatMap((definition) => definition.supervisors ?? [])
    .map((supervisor) => supervisor.scope),
  ['global'],
  'workspace-type supervisor listings are gated by module enablement (only multiloop remains)',
)

assert.equal(host.getWorkspaceTypeModule('sprintengine'), 'sprint-engine')
assert.equal(host.getWorkspaceTypeModule('guided-brief'), 'sprint-engine')
assert.equal(host.getWorkspaceTypeModule('switchboard'), 'switchboard')
assert.equal(host.getWorkspaceTypeModule('multiloop'), 'multiloop')
assert.equal(host.getWorkspaceTypeModule('automations'), undefined, 'automations is not a workspace type')

assert.deepEqual(
  ['switchboard', 'sprintengine', 'multiloop', 'guided-brief'].map((id) => {
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
      id: 'guided-brief',
      moduleId: 'sprint-engine',
      label: 'Design Wizard',
      description: 'Describe your idea in plain words. We turn it into a plan, screens, and a build — no setup needed.',
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
  collectWorkspaceTypeSupervisors(host.getWorkspaceTypes(), true).map((supervisor) => supervisor.key),
  ['sprintengine:global:0', 'multiloop:global:0'],
  'primary workspace window mounts global supervisor contributions in registry order (automations mounts its observer directly)',
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
  ['multiloop:global:0'],
  'disabling a module removes its supervisor contribution without affecting others',
)

// The always-mounted observer's per-event decision. A timer
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

// T13 C7/C9/C15: the mounted observer's subscription boundary — the exact wiring
// AutomationsRunSupervisor installs (subscribe to window.api.onAutomationRunEvent
// -> resolve folder -> publish), which the handler-only tests above did not
// cover. Proves a delivered timer failed/blocked event creates one
// source-'automations' notification, manual/completed are ignored, the listener
// is attached synchronously on mount, and the cleanup unsubscribes on unmount.
async function runSubscriptionBoundaryTest(): Promise<void> {
  let captured: ((event: AutomationsRunEvent) => void) | null = null
  let unsubscribed = false
  const api: AutomationRunEventSource = {
    onAutomationRunEvent: (listener) => {
      captured = listener
      return () => {
        unsubscribed = true
      }
    },
  }
  const published: DiagnosticLogInput[] = []
  // Mirrors the component's async store-backed resolver, kept out of the eager graph.
  const loadResolveFolderPath = async () => (workspaceId: string) =>
    workspaceId === 'ws-project' ? '/repo/app' : null

  const unsubscribe = subscribeAutomationRunNotifications(api, loadResolveFolderPath, (input) => published.push(input))
  assert.ok(captured, 'observer subscribes to onAutomationRunEvent synchronously on mount (no async gap)')
  const deliver = captured as (event: AutomationsRunEvent) => void

  const timerFailed: AutomationsRunEvent = {
    automationId: 'auto-3',
    runId: 'run-7',
    workspaceId: 'ws-project',
    definitionName: 'Nightly QA',
    status: 'failed',
    trigger: 'timer',
  }
  deliver(timerFailed)
  deliver({ ...timerFailed, status: 'blocked' })
  deliver({ ...timerFailed, trigger: 'manual' })
  deliver({ ...timerFailed, status: 'completed' })
  // Flush the deferred folder-resolution promise chain each delivered event queued.
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(published.length, 2, 'only the timer failed + blocked events publish through the subscription')
  assert.equal(published[0].source, 'automations')
  assert.equal(published[0].level, 'error', 'delivered timer failed event is error severity')
  assert.equal(published[1].level, 'warning', 'delivered timer blocked event is warning severity')
  assert.deepEqual(
    decodeRunRef(published[0].navigationTarget!.ref),
    { automationId: 'auto-3', runId: 'run-7', folderPath: '/repo/app' },
    'subscribed observer resolves the run folder for Open',
  )

  unsubscribe()
  assert.ok(unsubscribed, 'cleanup unsubscribes the observer on unmount')

  // Channel unavailable (older preload / disabled bridge): subscribing is a safe
  // no-op cleanup, never a throw at mount.
  const noopCleanup = subscribeAutomationRunNotifications({}, loadResolveFolderPath, () => {})
  noopCleanup()
}

void runSubscriptionBoundaryTest().then(
  () => console.log('bundled workspace type registration tests passed'),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
