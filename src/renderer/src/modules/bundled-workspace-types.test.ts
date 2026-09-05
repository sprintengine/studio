import assert from 'node:assert/strict'

import { getRendererHost, selectModuleEnabled } from './index'
import { createGuidedBriefTemplate } from './design-wizard-workspace-types'
import { createSprintEngineTemplate } from './sprint-engine-workspace-types'
import { createSwitchboardTemplate } from './switchboard-workspace-types'
import { collectWorkspaceTypeSupervisors } from './workspace-type-supervisors'
import {
  AUTOMATIONS_DOOR_TARGET_KIND,
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
    name: 'Sprint',
    description: 'Inbox, Agents, and Tasks together in one stable board.',
    previewSlots: [
      { label: 'Sprint', x: 4, y: 4, w: 292, h: 102, type: 'editor' },
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
              { type: 'tab', name: 'Sprint', component: 'sprintengine', enableClose: false },
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
}

assert.deepEqual(createSprintEngineTemplate(sprintEngineConfig), expectedTemplates.sprintengine)
assert.deepEqual(createGuidedBriefTemplate(), expectedTemplates['guided-brief'])
assert.deepEqual(createSwitchboardTemplate(), expectedTemplates.switchboard)

const host = getRendererHost()

assert.deepEqual(
  host.getWorkspaceTypes().map((definition) => definition.id),
  ['switchboard', 'sprintengine', 'automations-host', 'guided-brief'],
  'bundled workspace types keep picker order; the review workspace type retired (MC-1708 — reviews are an instance-level surface) and the roadmap type retired (MC-1692)',
)
// guided-brief moved onto its own design-wizard module (MC-1860), so a raw
// module-id predicate no longer takes it down with sprint-engine…
assert.deepEqual(
  host.getWorkspaceTypes((moduleId) => moduleId !== 'sprint-engine').map((definition) => definition.id),
  ['switchboard', 'automations-host', 'guided-brief'],
  'guided-brief is owned by design-wizard, not sprint-engine (MC-1860)',
)
// …but real enablement resolves the dependency graph: design-wizard declares
// dependsOn ['sprint-engine'], so disabling Sprint Engine cascades and hides
// the Design Wizard by DECLARED dependency (its build handoff creates a
// plan-sourced Sprint Engine run).
assert.deepEqual(
  host.getWorkspaceTypes((moduleId) => selectModuleEnabled({ 'sprint-engine': false }, moduleId)).map((definition) => definition.id),
  ['switchboard', 'automations-host'],
  'disabling sprint-engine cascades to design-wizard via dependsOn',
)
// Disabling design-wizard removes only the guided-brief type; Sprint Engine
// keeps its board and workspace type fully working.
assert.deepEqual(
  host.getWorkspaceTypes((moduleId) => selectModuleEnabled({ 'design-wizard': false }, moduleId)).map((definition) => definition.id),
  ['switchboard', 'sprintengine', 'automations-host'],
  'disabling design-wizard removes guided-brief from creation and leaves sprint-engine intact',
)
assert.deepEqual(
  host.getWorkspaceTypes((moduleId) => moduleId !== 'automations').map((definition) => definition.id),
  ['switchboard', 'sprintengine', 'guided-brief'],
  'disabling the automations module removes the automations-host workspace type from the picker',
)
assert.equal(host.getWorkspaceTypeModule('sprintengine'), 'sprint-engine')
assert.equal(host.getWorkspaceTypeModule('review'), undefined, 'the review workspace type retired (MC-1708); the review module owns the instance-level Reviews surface + panel, not a workspace type')
assert.equal(host.getWorkspaceTypeModule('roadmap'), undefined, 'the roadmap workspace type retired (MC-1692); the roadmap module owns the sidebar door, not a workspace type')
assert.equal(host.getWorkspaceTypeModule('guided-brief'), 'design-wizard', 'the Design Wizard workspace type is owned by its own module (MC-1860)')
assert.equal(host.getWorkspaceTypeModule('switchboard'), 'switchboard')
assert.equal(host.getWorkspaceTypeModule('automations-host'), 'automations', 'automations-host is owned by the automations module')
assert.equal(host.getWorkspaceTypeModule('automations'), undefined, "the type id is 'automations-host', not 'automations'")

// automations-host stays REGISTERED (the executor creates hidden host
// workspaces at runtime), but is withheld from the creation picker: automations
// are created from the full-page door now, not the new-workspace picker (item
// 1707). This is the picker analog of isHiddenFromRail — unlike review/roadmap,
// which retired their types entirely.
assert.equal(host.getWorkspaceType('automations-host')?.hiddenFromPicker, true, 'automations-host is hidden from the creation picker')

assert.deepEqual(
  ['switchboard', 'sprintengine', 'automations-host', 'guided-brief'].map((id) => {
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
      label: 'Sprint',
      // The old sprint-card marketing line died with the wizard page (MC-2062);
      // the rail row now describes the board, and selecting it opens the New
      // sprint dialog rather than a wizard flow. There is no sprint creation
      // flow, so the registration names no creationStepsId.
      description: 'Inbox, Agents, and Tasks together in one stable board.',
      accentToken: '--tool-sprintengine',
      creationStepsId: undefined,
    },
    {
      id: 'automations-host',
      moduleId: 'automations',
      label: 'Automations',
      description: 'Schedule agents and tasks on this project, with run history and the live run terminals hosted in one place.',
      accentToken: '--accent-primary',
      creationStepsId: 'automations',
    },
    {
      id: 'guided-brief',
      moduleId: 'design-wizard',
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

// The Sprint Engine auto-run supervisor is retired (sprint-runtime-ownership
// Phase 3): scheduling and session reconcile run in the main-process scheduler
// (src/main/sprint-runtime.ts); the renderer contributes NO supervisor.
assert.equal(
  host.getWorkspaceType('sprintengine')?.supervisors,
  undefined,
  'Sprint Engine contributes no renderer supervisor (main-process scheduler owns auto-run)',
)
assert.deepEqual(
  collectWorkspaceTypeSupervisors(host.getWorkspaceTypes(), true).map((supervisor) => supervisor.key),
  [],
  'no bundled workspace type contributes a renderer supervisor (automations mounts its observer directly)',
)
assert.deepEqual(
  collectWorkspaceTypeSupervisors(host.getWorkspaceTypes(), false).map((supervisor) => supervisor.key),
  [],
  'secondary workspace windows do not mount global supervisor contributions',
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
  assert.equal(failed.navigationTarget?.kind, AUTOMATIONS_DOOR_TARGET_KIND, 'carries the full-page door deep-link target (item 1707), not the retired host-reveal kind')
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
