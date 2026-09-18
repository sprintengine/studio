import assert from 'node:assert/strict'

import type { CapabilityManifest } from '../../../shared/modules/manifest'
import { normalizeModuleRegistrySnapshot, type ModuleRegistrySnapshot } from '../../../shared/modules/registry-snapshot'
import {
  buildModuleRegistrySnapshot,
  collectModuleSurfaces,
  startModuleRegistrySnapshotMirror,
  type ModuleSurfaceRegistry,
} from './registry-snapshot'

const AGENT_RUNTIME: CapabilityManifest = {
  id: 'agent-runtime',
  displayName: 'Agent runtime',
  version: 1,
  defaultEnabled: true,
  core: true,
}
const ATLAS: CapabilityManifest = {
  id: 'atlas',
  displayName: 'Atlas',
  version: 1,
  defaultEnabled: true,
  dependsOn: ['agent-runtime'],
}
const GIT: CapabilityManifest = { id: 'git', displayName: 'Git panel', version: 1, defaultEnabled: true }
const WEATHER: CapabilityManifest = {
  id: 'weather',
  displayName: 'Weather',
  version: 2,
  defaultEnabled: true,
  source: 'third-party',
  dependsOn: ['git'],
  permissions: ['workspace.read'],
}

type SurfaceKind =
  | 'workspaceTypes'
  | 'globalSurfaces'
  | 'modalSurfaces'
  | 'sidebarNavEntries'
  | 'settingsSections'
  | 'commands'
  | 'topBarItems'
  | 'backlogItemActions'

function registryOf(entries: Array<{ kind: SurfaceKind; id: string; moduleId: string }>): ModuleSurfaceRegistry {
  const of = (kind: SurfaceKind): Array<{ id: string; moduleId: string }> =>
    entries.filter((entry) => entry.kind === kind).map(({ id, moduleId }) => ({ id, moduleId }))
  return {
    getWorkspaceTypes: () => of('workspaceTypes'),
    getGlobalSurfaces: () => of('globalSurfaces'),
    getModalSurfaces: () => of('modalSurfaces'),
    getSidebarNavEntries: () => of('sidebarNavEntries'),
    getSettingsSections: () => of('settingsSections'),
    getModuleCommands: () => of('commands'),
    getTopBarItems: () => of('topBarItems'),
    getBacklogItemActions: () => of('backlogItemActions'),
  }
}

function testSurfacesAreGroupedByOwningModule(): void {
  const surfaces = collectModuleSurfaces(
    registryOf([
      { kind: 'globalSurfaces', id: 'charts', moduleId: 'atlas' },
      { kind: 'workspaceTypes', id: 'atlas-chart', moduleId: 'atlas' },
      { kind: 'commands', id: 'atlas.open-board', moduleId: 'atlas' },
      { kind: 'sidebarNavEntries', id: 'design', moduleId: 'design' },
    ]),
  )
  assert.deepEqual(surfaces['atlas'].globalSurfaces, ['charts'])
  assert.deepEqual(surfaces['atlas'].commands, ['atlas.open-board'])
  assert.deepEqual(surfaces['design'].sidebarNavEntries, ['design'])
  assert.equal(surfaces['atlas'].settingsSections.length, 0, 'a kind nobody registered stays empty')
}

function testEnablementMatchesWhatTheAppResolves(): void {
  const snapshot = buildModuleRegistrySnapshot({
    manifests: [AGENT_RUNTIME, ATLAS, GIT, WEATHER],
    // Git off by hand; Weather depends on it, so it cannot resolve either.
    overrides: { git: false },
    surfaces: collectModuleSurfaces(registryOf([{ kind: 'globalSurfaces', id: 'charts', moduleId: 'atlas' }])),
    channel: 'development',
    now: 1_000,
  })
  const byId = new Map(snapshot.modules.map((module) => [module.id, module]))
  assert.equal(byId.get('atlas')?.enabled, true)
  assert.equal(byId.get('atlas')?.absence, null)
  assert.deepEqual(byId.get('atlas')?.surfaces.globalSurfaces, ['charts'])
  assert.equal(byId.get('git')?.enabled, false)
  assert.equal(byId.get('git')?.absence?.reason, 'disabled', "the user's own switch reads as disabled")
  assert.equal(byId.get('weather')?.enabled, false)
  assert.equal(
    byId.get('weather')?.absence?.reason,
    'disabled_dependency',
    'a module blocked by its dependency says which failure it was, not just "off"',
  )
  assert.equal(byId.get('weather')?.source, 'third-party')
  assert.equal(byId.get('git')?.source, 'bundled', 'an unstamped manifest is bundled')
  assert.equal(snapshot.capturedAt, 1_000)
}

function testTheUniverseIsReportedAsGiven(): void {
  // The caller passes the channel-narrowed universe (`activeForChannel` already
  // applied). A module absent from it must not appear at all — a packaged build
  // reporting a dev-only module as "disabled" is the exact failure this guards.
  const snapshot = buildModuleRegistrySnapshot({
    manifests: [AGENT_RUNTIME, GIT],
    overrides: {},
    surfaces: {},
    channel: 'production',
    now: 2_000,
  })
  assert.deepEqual(
    snapshot.modules.map((module) => module.id),
    ['agent-runtime', 'git'],
  )
  assert.equal(snapshot.channel, 'production')
}

function testMirrorPushesOnChangeAndNotOtherwise(): void {
  let overrides: Record<string, boolean> = {}
  let clock = 0
  const pushed: ModuleRegistrySnapshot[] = []
  const listeners: Array<() => void> = []
  const stop = startModuleRegistrySnapshotMirror({
    push: (snapshot) => {
      pushed.push(snapshot)
      return true
    },
    build: () =>
      buildModuleRegistrySnapshot({
        manifests: [AGENT_RUNTIME, GIT],
        overrides,
        surfaces: {},
        channel: 'development',
        now: (clock += 10),
      }),
    subscribe: (onChange) => {
      listeners.push(onChange)
      return () => {
        listeners.length = 0
      }
    },
  })
  assert.equal(pushed.length, 1, 'the first snapshot is sent immediately')
  listeners[0]()
  assert.equal(pushed.length, 1, 'an unchanged registry is not re-sent just because the clock moved')
  overrides = { git: false }
  listeners[0]()
  assert.equal(pushed.length, 2, 'a real enablement change is pushed')
  assert.equal(pushed[1].modules.find((module) => module.id === 'git')?.enabled, false)
  stop()
  assert.equal(listeners.length, 0, 'the mirror can be stopped')
}

async function testARefusedPushIsRetriedNotForgotten(): Promise<void> {
  // Dedupe must not remember an undelivered snapshot: main would then sit on an
  // absent registry until something unrelated changed.
  const attempts: ModuleRegistrySnapshot[] = []
  let accept = false
  const listeners: Array<() => void> = []
  startModuleRegistrySnapshotMirror({
    build: () =>
      buildModuleRegistrySnapshot({
        manifests: [AGENT_RUNTIME],
        overrides: {},
        surfaces: {},
        channel: 'development',
        now: 1,
      }),
    push: async (snapshot) => {
      attempts.push(snapshot)
      return accept
    },
    subscribe: (onChange) => {
      listeners.push(onChange)
      return () => undefined
    },
  })
  await Promise.resolve()
  assert.equal(attempts.length, 1, 'the first push was attempted')
  accept = true
  listeners[0]()
  await Promise.resolve()
  assert.equal(attempts.length, 2, 'the identical snapshot is sent again after a refusal')
  listeners[0]()
  assert.equal(attempts.length, 2, 'once accepted, the identical snapshot stops being re-sent')
}

function testMainRefusesAMalformedSnapshot(): void {
  const snapshot = buildModuleRegistrySnapshot({
    manifests: [AGENT_RUNTIME, WEATHER],
    overrides: {},
    surfaces: collectModuleSurfaces(registryOf([{ kind: 'commands', id: 'weather.refresh', moduleId: 'weather' }])),
    channel: 'development',
    now: 3_000,
  })
  // Round-trips through JSON exactly as the IPC push does.
  const accepted = normalizeModuleRegistrySnapshot(JSON.parse(JSON.stringify(snapshot)))
  assert.deepEqual(accepted, snapshot, 'a real snapshot survives the boundary unchanged')

  for (const [label, malformed] of [
    ['not an object', 'nope'],
    ['unknown channel', { ...snapshot, channel: 'staging' }],
    // A reader formats this as a date; out-of-range would throw there instead.
    ['a timestamp outside the date range', { ...snapshot, capturedAt: 1e21 }],
    ['a zero timestamp', { ...snapshot, capturedAt: 0 }],
    ['modules not a list', { ...snapshot, modules: {} }],
    ['entry without an id', { ...snapshot, modules: [{ ...snapshot.modules[0], id: '' }] }],
    ['entry with an unknown source', { ...snapshot, modules: [{ ...snapshot.modules[0], source: 'somewhere' }] }],
    ['entry without an enabled flag', { ...snapshot, modules: [{ ...snapshot.modules[0], enabled: 'yes' }] }],
  ] as Array<[string, unknown]>) {
    assert.equal(normalizeModuleRegistrySnapshot(malformed), null, `refuses ${label}`)
  }
}

const tests = [
  testSurfacesAreGroupedByOwningModule,
  testEnablementMatchesWhatTheAppResolves,
  testTheUniverseIsReportedAsGiven,
  testMirrorPushesOnChangeAndNotOtherwise,
  testARefusedPushIsRetriedNotForgotten,
  testMainRefusesAMalformedSnapshot,
]

async function main(): Promise<void> {
  let failures = 0
  for (const test of tests) {
    try {
      await test()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`)
    process.exit(1)
  }
  console.log('registry-snapshot.test.ts: ok')
}

void main()
