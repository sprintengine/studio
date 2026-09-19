import assert from 'node:assert/strict'

import { getRendererHost } from './index'
import { createRendererHost } from './renderer-host'
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

const host = getRendererHost()

assert.deepEqual(
  host.getWorkspaceTypes().map((definition) => definition.id),
  ['automations-host'],
  'bundled workspace types keep picker order; the review workspace type retired (MC-1708 — reviews are an instance-level surface), the roadmap type retired (MC-1692), and the guided-brief type retired with the Design Wizard (2026-09-08)',
)
assert.deepEqual(
  host.getWorkspaceTypes((moduleId) => moduleId !== 'automations').map((definition) => definition.id),
  [],
  'disabling the automations module removes the automations-host workspace type from the picker',
)
assert.equal(
  host.getWorkspaceTypeModule('sprintengine'),
  undefined,
  'the in-tree sprint workspace type retired with the engine',
)
assert.equal(
  host.getWorkspaceTypeModule('review'),
  undefined,
  'the review workspace type retired (MC-1708); the review module owns the instance-level Reviews surface + panel, not a workspace type',
)
assert.equal(
  host.getWorkspaceTypeModule('roadmap'),
  undefined,
  'the roadmap workspace type retired (MC-1692); the roadmap module owns the sidebar door, not a workspace type',
)
assert.equal(
  host.getWorkspaceTypeModule('guided-brief'),
  undefined,
  'the guided-brief workspace type retired with the Design Wizard (2026-09-08); its module id stays reserved but registers nothing',
)
assert.equal(
  host.getWorkspaceTypeModule('automations-host'),
  'automations',
  'automations-host is owned by the automations module',
)
assert.equal(
  host.getWorkspaceTypeModule('automations'),
  undefined,
  "the type id is 'automations-host', not 'automations'",
)

// automations-host stays REGISTERED (the executor creates hidden host
// workspaces at runtime), but is withheld from the creation picker: automations
// are created from the full-page door now, not the new-workspace picker (item
// 1707). This is the picker analog of isHiddenFromRail — unlike review/roadmap,
// which retired their types entirely.
assert.equal(
  host.getWorkspaceType('automations-host')?.hiddenFromPicker,
  true,
  'automations-host is hidden from the creation picker',
)

assert.deepEqual(
  ['automations-host'].map((id) => {
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
      id: 'automations-host',
      moduleId: 'automations',
      label: 'Automations',
      description:
        'Schedule agents and tasks on this project, with run history and the live run terminals hosted in one place.',
      accentToken: '--accent-primary',
      creationStepsId: 'automations',
    },
  ],
  'registered metadata matches the existing mode picker and top-bar copy',
)

// Which of a type's supervisors a window mounts. `all-windows` mounts
// everywhere; `global` mounts only on the window that owns the global ones, so
// a single-instance watcher never runs twice. No bundled type contributes a
// supervisor today — Automations mounts its observer directly — so the seam is
// exercised against a type registered here.
{
  const supervisorHost = createRendererHost()
  const Noop = () => null
  supervisorHost.hostFor('tide-tables').registerWorkspaceType({
    id: 'tide-tables',
    label: 'Tide tables',
    description: 'A workspace type registered for this check alone.',
    icon: () => null,
    createTemplate: () => ({
      id: 'tide-tables',
      name: 'Tide tables',
      description: 'A workspace type registered for this check alone.',
      previewSlots: [],
      layout: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    }),
    supervisors: [
      { scope: 'all-windows', Component: Noop },
      { scope: 'global', Component: Noop },
    ],
  } as never)
  const types = supervisorHost.getWorkspaceTypes()
  assert.deepEqual(
    collectWorkspaceTypeSupervisors(types, true).map((supervisor) => supervisor.key),
    ['tide-tables:all-windows:0', 'tide-tables:global:1'],
    'the window that owns the global supervisors mounts both',
  )
  assert.deepEqual(
    collectWorkspaceTypeSupervisors(types, false).map((supervisor) => supervisor.key),
    ['tide-tables:all-windows:0'],
    'a secondary window mounts only the all-windows supervisors',
  )
  assert.deepEqual(
    collectWorkspaceTypeSupervisors(getRendererHost().getWorkspaceTypes(), true),
    [],
    'no bundled workspace type contributes a supervisor',
  )
}

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
  assert.equal(
    failed.navigationTarget?.kind,
    AUTOMATIONS_DOOR_TARGET_KIND,
    'carries the full-page door deep-link target (item 1707), not the retired host-reveal kind',
  )
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
  const completed = scheduledRunNotification({ ...baseEvent, status: 'completed' }, () => '/repo/app')
  assert.equal(
    completed?.level,
    'info',
    'a completed scheduled run is an info row — the rail’s Automations badge counts it, the bell’s error count and the toast never see it',
  )
  assert.equal(completed?.title, 'Automation finished: Nightly QA')
  assert.equal(
    completed?.navigationTarget?.kind,
    AUTOMATIONS_DOOR_TARGET_KIND,
    'and opens the door at the run like the others',
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
  handleAutomationRunEvent({ ...event, status: 'completed' }, resolveFolderPath, (input) =>
    completedPublished.push(input),
  )
  assert.equal(
    completedPublished.length,
    1,
    'a completed timer run publishes an info row for the rail’s Automations badge',
  )
  assert.equal(completedPublished[0]?.level, 'info', 'info: the bell’s error count and the toast never see it')
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
  const loadResolveFolderPath = async () => (workspaceId: string) => (workspaceId === 'ws-project' ? '/repo/app' : null)

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

  assert.equal(published.length, 3, 'every timer event publishes through the subscription; the manual one is T6’s')
  assert.equal(published[0].source, 'automations')
  assert.equal(published[0].level, 'error', 'delivered timer failed event is error severity')
  assert.equal(published[1].level, 'warning', 'delivered timer blocked event is warning severity')
  assert.equal(published[2].level, 'info', 'delivered timer completed event is an info row (rail badge, no toast)')
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
