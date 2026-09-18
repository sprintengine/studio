import assert from 'node:assert/strict'

import type { CapabilityManifest, ThirdPartyRendererEntriesResult } from '../../../shared/modules/manifest'
import { createRendererHost, type RendererHost } from './renderer-host'
import {
  getThirdPartyRendererLoadState,
  loadThirdPartyRendererEntries,
  rendererEntriesForRefresh,
  type ThirdPartyEntryImporter,
} from './third-party-loader'

// The loader is the execution boundary for third-party renderer code: these
// tests pin the reserved-id re-check, per-module failure isolation (one broken
// bundle must never block its neighbors), the registerRenderer contract, and
// the rule that only cleanly loaded modules join the enablement universe.
// Bundle evaluation itself (blob URL + import map) runs in the real app and is
// covered by the Electron playwright harness; here the importer is injected.

function manifest(id: string): CapabilityManifest {
  return { id, displayName: id, version: 1, defaultEnabled: true, source: 'third-party' }
}

function served(
  entries: Array<{ id: string; manifest?: CapabilityManifest; code?: string; assetOrigin?: string }>,
  failures: Record<string, string> = {},
): ThirdPartyRendererEntriesResult {
  return {
    entries: entries.map((entry) => ({
      id: entry.id,
      manifest: entry.manifest ?? manifest(entry.id),
      code: entry.code ?? `// ${entry.id}`,
      ...(entry.assetOrigin ? { assetOrigin: entry.assetOrigin } : {}),
    })),
    failures,
  }
}

const importerFor =
  (modules: Record<string, unknown>): ThirdPartyEntryImporter =>
  async (code) => {
    const id = code.replace('// ', '')
    if (!(id in modules)) throw new Error(`Unexpected import for "${id}"`)
    const value = modules[id]
    if (value instanceof Error) throw value
    return value
  }

async function testLoadsAndRegistersUnderOwnModuleId(): Promise<void> {
  const kernel = createRendererHost()
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([{ id: 'loader-demo', assetOrigin: 'studio-module://' + 'a'.repeat(64) }]),
    importerFor({
      'loader-demo': {
        registerRenderer: (host: RendererHost) => {
          assert.equal(
            host.getAssetUrl('runtime/index.html'),
            'studio-module://' + 'a'.repeat(64) + '/runtime/index.html',
          )
          host.registerPanel('loader-demo.panel', () => null)
        },
      },
    }),
  )
  assert.deepEqual(
    loaded.map((entry) => entry.id),
    ['loader-demo'],
  )
  assert.equal(kernel.getPanelModule('loader-demo.panel'), 'loader-demo')
  assert.deepEqual(getThirdPartyRendererLoadState('loader-demo'), { status: 'loaded' })
}

async function testReservedIdIsRejectedWithoutEvaluation(): Promise<void> {
  const kernel = createRendererHost()
  let imported = 0
  const loaded = await loadThirdPartyRendererEntries(kernel, served([{ id: 'git' }]), async () => {
    imported += 1
    return {}
  })
  assert.deepEqual(loaded, [])
  assert.equal(imported, 0, 'reserved-id bundles must never be evaluated')
  const state = getThirdPartyRendererLoadState('git')
  assert.equal(state?.status, 'error')
  assert.match(state.message, /reserved id, publisher-locked/)
}

// Publisher-locked, not absolutely blocked: a reserved-id entry that main
// verified as first-party-signed (the stamped flag) loads normally — that's
// how extracted first-party modules keep their ids.
async function testReservedIdWithFirstPartyStampLoads(): Promise<void> {
  const kernel = createRendererHost()
  const entries = served([{ id: 'memory-graph' }])
  entries.entries[0]!.firstPartySigned = true
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    entries,
    importerFor({
      'memory-graph': {
        registerRenderer: (host: RendererHost) => {
          host.registerPanel('memory-graph.reserved-proof-panel', () => null)
        },
      },
    }),
  )
  assert.deepEqual(
    loaded.map((entry) => entry.id),
    ['memory-graph'],
  )
  assert.deepEqual(getThirdPartyRendererLoadState('memory-graph'), { status: 'loaded' })
}

async function testManifestIdMismatchIsRejected(): Promise<void> {
  const kernel = createRendererHost()
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([{ id: 'loader-mismatch', manifest: manifest('something-else') }]),
    async () => ({ registerRenderer: () => {} }),
  )
  assert.deepEqual(loaded, [])
  const state = getThirdPartyRendererLoadState('loader-mismatch')
  assert.equal(state?.status, 'error')
  assert.match(state.message, /does not match/)
}

async function testMissingRegisterRendererExportIsAnError(): Promise<void> {
  const kernel = createRendererHost()
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([{ id: 'loader-no-export' }]),
    importerFor({ 'loader-no-export': { somethingElse: true } }),
  )
  assert.deepEqual(loaded, [])
  const state = getThirdPartyRendererLoadState('loader-no-export')
  assert.equal(state?.status, 'error')
  assert.match(state.message, /must export a registerRenderer/)
}

async function testBrokenBundleIsIsolatedFromNeighbors(): Promise<void> {
  const kernel = createRendererHost()
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([{ id: 'loader-broken' }, { id: 'loader-healthy' }]),
    importerFor({
      'loader-broken': new Error('boom at import time'),
      'loader-healthy': {
        registerRenderer: (host: RendererHost) => {
          host.registerPanel('loader-healthy.panel', () => null)
        },
      },
    }),
  )
  assert.deepEqual(
    loaded.map((entry) => entry.id),
    ['loader-healthy'],
  )
  assert.deepEqual(getThirdPartyRendererLoadState('loader-broken'), {
    status: 'error',
    message: 'boom at import time',
  })
  assert.equal(kernel.getPanelModule('loader-healthy.panel'), 'loader-healthy')
}

async function testRegistrationFailureExcludesModuleFromUniverse(): Promise<void> {
  const kernel = createRendererHost()
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([{ id: 'loader-half' }]),
    importerFor({
      'loader-half': {
        registerRenderer: (host: RendererHost) => {
          host.registerPanel('loader-half.panel', () => null)
          throw new Error('registration exploded')
        },
      },
    }),
  )
  // The first panel registered, but the module failed: it must not join the
  // enablement universe, so its partial contributions stay gated off.
  assert.deepEqual(loaded, [])
  assert.deepEqual(getThirdPartyRendererLoadState('loader-half'), {
    status: 'error',
    message: 'registration exploded',
  })
}

// MC-1854: a third-party module claiming a global-surface id another module
// already owns is a per-module LOAD ERROR — never a throw that kills the
// registration pass — and its other contributions stay gated off with it.
async function testClaimedGlobalSurfaceIdIsALoadError(): Promise<void> {
  const kernel = createRendererHost()
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([{ id: 'atlas-owner' }, { id: 'atlas-impostor' }, { id: 'atlas-bystander' }]),
    importerFor({
      'atlas-owner': {
        registerRenderer: (host: RendererHost) => {
          host.registerGlobalSurface({ id: 'atlas', Component: () => null })
        },
      },
      'atlas-impostor': {
        registerRenderer: (host: RendererHost) => {
          host.registerSidebarNavEntry({ id: 'atlas-impostor', order: 90, Component: () => null })
          host.registerGlobalSurface({ id: 'atlas', Component: () => null })
        },
      },
      'atlas-bystander': {
        registerRenderer: (host: RendererHost) => {
          host.registerPanel('atlas-bystander.panel', () => null)
        },
      },
    }),
  )
  // The impostor is a load error; its neighbors — including one registered
  // AFTER the failure — load cleanly.
  assert.deepEqual(
    loaded.map((entry) => entry.id),
    ['atlas-owner', 'atlas-bystander'],
  )
  const state = getThirdPartyRendererLoadState('atlas-impostor')
  assert.equal(state?.status, 'error')
  assert.match(state.message, /Global surface "atlas" is already registered by module "atlas-owner"/)
  // The claimed surface keeps its first owner...
  assert.equal(kernel.getGlobalSurface('atlas')?.moduleId, 'atlas-owner')
  // ...and the impostor's OTHER contributions do not register: it never joins
  // the enablement universe, so the nav entry it got in before the throw is
  // gated off everywhere consumers filter by enablement.
  const loadedIds = new Set(loaded.map((entry) => entry.id))
  assert.ok(
    !kernel.getSidebarNavEntries((moduleId) => loadedIds.has(moduleId)).some((entry) => entry.id === 'atlas-impostor'),
    'a failed module’s nav entry must not survive enablement filtering',
  )
}

async function testAbsolutePathInErrorIsSanitized(): Promise<void> {
  const kernel = createRendererHost()
  await loadThirdPartyRendererEntries(
    kernel,
    served([{ id: 'loader-leaky' }]),
    importerFor({ 'loader-leaky': new Error('ENOENT: /Users/someone/.multicode/modules/x.js') }),
  )
  const state = getThirdPartyRendererLoadState('loader-leaky')
  assert.equal(state?.status, 'error')
  assert.doesNotMatch(state.message, /\/Users\//)
  assert.equal(state.message, 'entry.renderer bundle failed to load.')
}

async function testServingFailuresAreRecorded(): Promise<void> {
  const kernel = createRendererHost()
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([], { 'loader-unservable': 'entry.renderer bundle file is missing.' }),
    async () => ({}),
  )
  assert.deepEqual(loaded, [])
  assert.deepEqual(getThirdPartyRendererLoadState('loader-unservable'), {
    status: 'error',
    message: 'entry.renderer bundle file is missing.',
  })
}

async function testDuplicateIdKeepsFirstDefinition(): Promise<void> {
  const kernel = createRendererHost()
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([
      { id: 'loader-dupe', code: '// loader-dupe' },
      { id: 'loader-dupe', code: '// loader-dupe-second' },
    ]),
    async (code) =>
      code === '// loader-dupe'
        ? {
            registerRenderer: (host: RendererHost) => {
              host.registerPanel('loader-dupe.panel', () => null)
            },
          }
        : { registerRenderer: () => {} },
  )
  assert.deepEqual(
    loaded.map((entry) => entry.id),
    ['loader-dupe'],
  )
  assert.deepEqual(getThirdPartyRendererLoadState('loader-dupe'), { status: 'loaded' })
}

async function main(): Promise<void> {
  await testLoadsAndRegistersUnderOwnModuleId()
  await testReservedIdIsRejectedWithoutEvaluation()
  await testReservedIdWithFirstPartyStampLoads()
  await testManifestIdMismatchIsRejected()
  await testMissingRegisterRendererExportIsAnError()
  await testBrokenBundleIsIsolatedFromNeighbors()
  await testRegistrationFailureExcludesModuleFromUniverse()
  await testClaimedGlobalSurfaceIdIsALoadError()
  await testAbsolutePathInErrorIsSanitized()
  await testServingFailuresAreRecorded()
  await testDuplicateIdKeepsFirstDefinition()
  const refreshKernel = createRendererHost()
  const newlyInstalled = served([
    { id: 'refresh-game', manifest: { ...manifest('refresh-game'), entry: { renderer: 'game.js' } } },
    { id: 'refresh-main', manifest: { ...manifest('refresh-main'), entry: { main: 'main.cjs', renderer: 'ui.js' } } },
    {
      id: 'refresh-preload',
      manifest: { ...manifest('refresh-preload'), entry: { preload: 'preload.js', renderer: 'ui.js' } },
    },
    { id: 'refresh-broken' },
  ])
  const eligible = rendererEntriesForRefresh(newlyInstalled)
  assert.deepEqual(
    eligible.entries.map((entry) => entry.id),
    ['refresh-game', 'refresh-broken'],
    'hot activation excludes main/preload modules until restart',
  )
  let evaluations = 0
  const importFresh: ThirdPartyEntryImporter = async (code) => {
    evaluations++
    if (code.includes('refresh-broken')) throw new Error('broken renderer')
    return { registerRenderer: (host: RendererHost) => host.registerPanel('refresh-game.panel', () => null) }
  }
  const fresh = await loadThirdPartyRendererEntries(refreshKernel, eligible, importFresh)
  assert.deepEqual(
    fresh.map((entry) => entry.id),
    ['refresh-game'],
    'failure isolation also holds during refresh',
  )
  assert.equal(refreshKernel.getPanelModule('refresh-game.panel'), 'refresh-game')
  await loadThirdPartyRendererEntries(refreshKernel, rendererEntriesForRefresh(newlyInstalled), importFresh)
  assert.equal(evaluations, 2, 'neither loaded nor failed entries are ever reevaluated on refresh')
  assert.deepEqual(
    rendererEntriesForRefresh({ entries: [], failures: { 'refresh-game': 'updated file missing' } }).failures,
    {},
    'an update failure cannot overwrite the state of already running code',
  )
  console.log('third-party-loader tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
