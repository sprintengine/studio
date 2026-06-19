import assert from 'node:assert/strict'

import { getRendererHost } from './index'
import { createMultiloopTemplate } from './multiloop-workspace-types'
import { createGuidedBriefTemplate, createSprintEngineTemplate } from './sprint-engine-workspace-types'
import { createSwitchboardTemplate } from './switchboard-workspace-types'
import { collectWorkspaceTypeSupervisors } from './workspace-type-supervisors'
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
  'bundled workspace types keep the existing picker order',
)
assert.deepEqual(
  host.getWorkspaceTypes((moduleId) => moduleId !== 'sprint-engine').map((definition) => definition.id),
  ['switchboard', 'multiloop'],
  'sprint-engine disablement hides sprintengine and dependent guided-brief',
)
assert.deepEqual(
  host.getWorkspaceTypes((moduleId) => moduleId !== 'sprint-engine')
    .flatMap((definition) => definition.supervisors ?? [])
    .map((supervisor) => supervisor.scope),
  ['global'],
  'workspace-type supervisor listings are gated by module enablement',
)

assert.equal(host.getWorkspaceTypeModule('sprintengine'), 'sprint-engine')
assert.equal(host.getWorkspaceTypeModule('guided-brief'), 'sprint-engine')
assert.equal(host.getWorkspaceTypeModule('switchboard'), 'switchboard')
assert.equal(host.getWorkspaceTypeModule('multiloop'), 'multiloop')

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
  ['multiloop:global:0'],
  'disabling a module removes its supervisor contribution without affecting others',
)

console.log('bundled workspace type registration tests passed')
