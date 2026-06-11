import assert from 'node:assert/strict'

import type { CapabilityManifest, ThirdPartyRendererEntriesResult } from '../../../shared/modules/manifest'
import { createRendererHost, type RendererHost } from './renderer-host'
import {
  getThirdPartyRendererLoadState,
  loadThirdPartyRendererEntries,
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
  entries: Array<{ id: string; manifest?: CapabilityManifest; code?: string }>,
  failures: Record<string, string> = {}
): ThirdPartyRendererEntriesResult {
  return {
    entries: entries.map((entry) => ({
      id: entry.id,
      manifest: entry.manifest ?? manifest(entry.id),
      code: entry.code ?? `// ${entry.id}`,
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
    served([{ id: 'loader-demo' }]),
    importerFor({
      'loader-demo': {
        registerRenderer: (host: RendererHost) => {
          host.registerPanel('loader-demo.panel', () => null)
        },
      },
    })
  )
  assert.deepEqual(loaded.map((entry) => entry.id), ['loader-demo'])
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
  assert.match(state.message, /reserved built-in module id/)
}

async function testManifestIdMismatchIsRejected(): Promise<void> {
  const kernel = createRendererHost()
  const loaded = await loadThirdPartyRendererEntries(
    kernel,
    served([{ id: 'loader-mismatch', manifest: manifest('something-else') }]),
    async () => ({ registerRenderer: () => {} })
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
    importerFor({ 'loader-no-export': { somethingElse: true } })
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
    })
  )
  assert.deepEqual(loaded.map((entry) => entry.id), ['loader-healthy'])
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
    })
  )
  // The first panel registered, but the module failed: it must not join the
  // enablement universe, so its partial contributions stay gated off.
  assert.deepEqual(loaded, [])
  assert.deepEqual(getThirdPartyRendererLoadState('loader-half'), {
    status: 'error',
    message: 'registration exploded',
  })
}

async function testAbsolutePathInErrorIsSanitized(): Promise<void> {
  const kernel = createRendererHost()
  await loadThirdPartyRendererEntries(
    kernel,
    served([{ id: 'loader-leaky' }]),
    importerFor({ 'loader-leaky': new Error('ENOENT: /Users/someone/.multicode/modules/x.js') })
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
    async () => ({})
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
        : { registerRenderer: () => {} }
  )
  assert.deepEqual(loaded.map((entry) => entry.id), ['loader-dupe'])
  assert.deepEqual(getThirdPartyRendererLoadState('loader-dupe'), { status: 'loaded' })
}

async function main(): Promise<void> {
  await testLoadsAndRegistersUnderOwnModuleId()
  await testReservedIdIsRejectedWithoutEvaluation()
  await testManifestIdMismatchIsRejected()
  await testMissingRegisterRendererExportIsAnError()
  await testBrokenBundleIsIsolatedFromNeighbors()
  await testRegistrationFailureExcludesModuleFromUniverse()
  await testAbsolutePathInErrorIsSanitized()
  await testServingFailuresAreRecorded()
  await testDuplicateIdKeepsFirstDefinition()
  console.log('third-party-loader tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
