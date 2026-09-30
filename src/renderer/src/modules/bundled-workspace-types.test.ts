import assert from 'node:assert/strict'

import { getRendererHost } from './index'
import { createRendererHost } from './renderer-host'
import { collectWorkspaceTypeSupervisors } from './workspace-type-supervisors'
import { test } from 'vitest'

test('bundled-workspace-types', async () => {
  const host = getRendererHost()

  assert.deepEqual(
    host.getWorkspaceTypes().map((definition) => definition.id),
    [],
    'no bundled workspace type is registered: the review, roadmap, guided-brief and automations-host types all retired',
  )
  assert.equal(
    host.getWorkspaceTypeModule('sprintengine'),
    undefined,
    'the in-tree sprint workspace type retired with the engine',
  )
  assert.equal(
    host.getWorkspaceTypeModule('review'),
    undefined,
    'the review workspace type retired; the review module owns the instance-level Reviews surface + panel, not a workspace type',
  )
  assert.equal(
    host.getWorkspaceTypeModule('roadmap'),
    undefined,
    'the roadmap workspace type retired; the roadmap module owns the sidebar door, not a workspace type',
  )
  assert.equal(
    host.getWorkspaceTypeModule('guided-brief'),
    undefined,
    'the guided-brief workspace type retired with the Design Wizard (2026-09-08); its module id stays reserved but registers nothing',
  )
  assert.equal(
    host.getWorkspaceTypeModule('automations-host'),
    undefined,
    'the automations-host type retired with Automations (2026-09-30); scheduled agents register no workspace type',
  )

  // Which of a type's supervisors a window mounts. `all-windows` mounts
  // everywhere; `global` mounts only on the window that owns the global ones, so
  // a single-instance watcher never runs twice. No bundled type contributes a
  // supervisor today, so the seam is exercised against a type registered here.
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
})
