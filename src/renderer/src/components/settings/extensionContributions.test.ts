import { expect, test } from 'vitest'

import { deriveContributions, moduleDoorIcon, type ContributionRegistry } from './extensionContributions'

const Glyph = () => null

const registry: ContributionRegistry = {
  getGlobalSurfaces: () => [
    { moduleId: 'radar', id: 'pr-radar', label: 'PR Radar', Icon: Glyph },
    { moduleId: 'other', id: 'other-door', label: 'Other' },
  ],
  getWorkspaceTypes: () => [{ moduleId: 'radar', label: 'Review' }],
  getModalSurfaces: () => [],
  getModuleCommands: () => [{ moduleId: 'radar' }, { moduleId: 'radar' }, { moduleId: 'other' }],
  getSettingsSections: () => [{ moduleId: 'radar', label: 'PR Radar' }],
  getTopBarItems: () => [{ moduleId: 'radar' }],
  getBacklogItemActions: () => [{ moduleId: 'radar' }],
  getFileActions: () => [],
}

test('what a loaded module adds is read off what it registered, and only its own', () => {
  expect(deriveContributions('radar', registry, { rendererLoaded: true, mcpTools: ['a', 'b', 'c'] })).toEqual([
    { kind: 'door', label: 'PR Radar door' },
    { kind: 'workspace', label: 'Review workspace' },
    { kind: 'settings', label: 'PR Radar settings' },
    { kind: 'top-bar', label: '1 top-bar control' },
    { kind: 'command', label: '2 commands' },
    { kind: 'action', label: '1 Backlog action' },
    { kind: 'tools', label: '3 agent tools' },
  ])
})

test('a module whose code has not run here adds nothing known, not nothing', () => {
  expect(deriveContributions('radar', registry, { rendererLoaded: false })).toBeNull()
  expect(deriveContributions('quiet', registry, { rendererLoaded: true, mcpTools: [] })).toBeNull()
})

test('main-side tools alone are enough to say what a background-only module adds', () => {
  expect(deriveContributions('worker', registry, { rendererLoaded: false, mcpTools: ['worker.run'] })).toEqual([
    { kind: 'tools', label: '1 agent tool' },
  ])
})

test('a door view is a door each', () => {
  const withViews: ContributionRegistry = {
    ...registry,
    getGlobalSurfaces: () => [{ moduleId: 'kit', id: 'kit', views: [{ label: 'Plugins' }, { label: 'Skills' }] }],
  }
  expect(deriveContributions('kit', withViews, { rendererLoaded: true })).toEqual([
    { kind: 'door', label: 'Plugins door' },
    { kind: 'door', label: 'Skills door' },
  ])
})

test('the row wears its door’s own glyph when it registered one', () => {
  expect(moduleDoorIcon('radar', registry)).toBe(Glyph)
  expect(moduleDoorIcon('other', registry)).toBeNull()
})
