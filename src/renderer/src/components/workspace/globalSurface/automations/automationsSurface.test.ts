import assert from 'node:assert/strict'

import { getRendererHost } from '../../../../modules'
import { AUTOMATIONS_HOST_WORKSPACE_MODE } from '../../../../types/workspace'
import type { AppNotification } from '../../../../types/workspace'
import { automationsDoorTarget } from '../../../automations/runTarget'
import {
  consumePendingAutomationSurfaceTarget,
  dispatchAutomationSurfaceTarget,
} from './automationSurfaceTarget'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// The real kernel, with every bundled module registered (mirrors how
// bundled-workspace-types.test.ts exercises registration end-to-end and avoids a
// circular init from importing a single module file directly).
const host = getRendererHost()

run('registers the Automations DOOR (Extensions drawer ruling, 2026-09-05)', () => {
  // Automations was a top-nav door, then a modal (2026-09-01), and is a door
  // again: it routes the card region rather than floating over it. Its row is
  // the app rail's middle square, not a sidebar nav entry and not an Extensions
  // drawer row — it is what the product DOES, not something added to it.
  assert.equal(
    host.getSidebarNavEntries().find((entry) => entry.id === 'automations'),
    undefined,
    'no sidebar nav door with id "automations" remains',
  )
  assert.equal(host.getModalSurface('automations'), undefined, 'and nothing is registered as a modal')
  const door = host.getGlobalSurface('automations')
  assert.ok(door, 'a global surface with id "automations" is registered')
  assert.equal(door?.label, 'Automations', 'the rail square’s tooltip and the door’s name')
  assert.ok(door?.Icon, 'and its glyph, so a disabled module takes the square with it')
  assert.equal(door?.moduleId, 'automations', 'the surface is owned by the automations module')
  // No railPlacement: the default swap. The automations this window can see ARE
  // the navigation while the surface is open (the ruling’s frame 4), so its
  // rail takes the sidebar column exactly as Sprints’ list of runs does.
  assert.equal(door?.railPlacement, undefined, 'Automations keeps the context-rail swap')
})

run('keeps the automations-host type registered but hidden from the creation picker', () => {
  const hostType = host.getWorkspaceType(AUTOMATIONS_HOST_WORKSPACE_MODE)
  assert.ok(hostType, 'the automations-host workspace type stays registered for the runtime container')
  assert.equal(hostType?.hiddenFromPicker, true, 'but it is withheld from the new-workspace picker')
})

run('the run notification routes to the door for the door target and the legacy run kind', () => {
  const provider = host.getNotificationActionProviders().find((entry) => entry.source === 'automations')
  assert.ok(provider, 'a source-automations notification provider is registered')

  const withTarget = (navigationTarget: AppNotification['navigationTarget']): AppNotification =>
    ({ navigationTarget } as unknown as AppNotification)

  const doorActions = provider!.resolveActions({
    notification: withTarget(automationsDoorTarget('auto-1', 'run-9', '/repo/app')),
    revealWorkspace: () => {},
  })
  assert.equal(doorActions.length, 1, 'the door target yields one action')
  assert.equal(doorActions[0]?.id, 'automations.open-run')
  assert.equal(doorActions[0]?.label, 'Open')

  const legacyActions = provider!.resolveActions({
    notification: withTarget({ kind: 'run', ref: automationsDoorTarget('auto-2', 'run-3', null).ref }),
    revealWorkspace: () => {},
  })
  assert.equal(legacyActions.length, 1, 'a legacy run-kind target still routes to the door')

  const noneActions = provider!.resolveActions({
    notification: withTarget({ kind: 'task', ref: 'x' }),
    revealWorkspace: () => {},
  })
  assert.equal(noneActions.length, 0, 'a foreign target yields no automations action')
})

// The deep-link latch the door action feeds and the surface drains on mount.
run('the surface target latch carries the ref for a door target and rejects foreign ones', () => {
  dispatchAutomationSurfaceTarget(automationsDoorTarget('auto-7', 'run-2', '/repo/app'))
  const drained = consumePendingAutomationSurfaceTarget()
  assert.deepEqual(drained, {
    ref: { automationId: 'auto-7', runId: 'run-2', folderPath: '/repo/app' },
    view: 'runs',
  })
  assert.equal(consumePendingAutomationSurfaceTarget(), null, 'draining is once-only')

  dispatchAutomationSurfaceTarget({ kind: 'task', ref: 'x' })
  assert.equal(consumePendingAutomationSurfaceTarget(), null, 'a foreign target never latches')

  // The newest dispatch wins if the surface has not drained yet.
  dispatchAutomationSurfaceTarget(automationsDoorTarget('first', 'r1', null))
  dispatchAutomationSurfaceTarget(automationsDoorTarget('second', 'r2', null))
  assert.equal(consumePendingAutomationSurfaceTarget()?.ref.automationId, 'second')
})

// MC-2035: the shelf's Get hands an automation over for tailoring, not for
// reading its run history — the same seam and the same decoder, one extra bit of
// intent. A run notification keeps landing on `runs`, asserted above.
run('the latch carries the editor view the Extensions shelf asks for', () => {
  dispatchAutomationSurfaceTarget(automationsDoorTarget('auto-9', '', '/repo/app'), 'editor')
  const drained = consumePendingAutomationSurfaceTarget()
  assert.equal(drained?.view, 'editor', 'the view rides beside the ref')
  assert.equal(drained?.ref.automationId, 'auto-9', 'and names the automation the shelf just added')
  assert.equal(drained?.ref.runId, '', 'with no run to focus')

  // The legacy run kind still decodes, and defaults to the run history.
  dispatchAutomationSurfaceTarget({ kind: 'run', ref: automationsDoorTarget('auto-3', 'run-1', null).ref })
  assert.equal(consumePendingAutomationSurfaceTarget()?.view, 'runs', 'a persisted notification never opens the editor')
})

console.log('all automations surface tests passed')
