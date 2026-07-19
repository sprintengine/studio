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

run('registers the Automations door (order 10) and its full-page surface', () => {
  const door = host.getSidebarNavEntries().find((entry) => entry.id === 'automations')
  assert.ok(door, 'a sidebar nav door with id "automations" is registered')
  assert.equal(door?.order, 10, 'the door keeps the slot the hardcoded built-in used')
  assert.equal(door?.moduleId, 'automations', 'the door is owned by the automations module')
  assert.ok(host.getGlobalSurface('automations'), 'a global surface with id "automations" is registered')
  assert.equal(host.getGlobalSurface('automations')?.moduleId, 'automations')
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
  assert.deepEqual(drained, { automationId: 'auto-7', runId: 'run-2', folderPath: '/repo/app' })
  assert.equal(consumePendingAutomationSurfaceTarget(), null, 'draining is once-only')

  dispatchAutomationSurfaceTarget({ kind: 'task', ref: 'x' })
  assert.equal(consumePendingAutomationSurfaceTarget(), null, 'a foreign target never latches')

  // The newest dispatch wins if the surface has not drained yet.
  dispatchAutomationSurfaceTarget(automationsDoorTarget('first', 'r1', null))
  dispatchAutomationSurfaceTarget(automationsDoorTarget('second', 'r2', null))
  assert.equal(consumePendingAutomationSurfaceTarget()?.automationId, 'second')
})

console.log('all automations surface tests passed')
