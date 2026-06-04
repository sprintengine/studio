import assert from 'node:assert/strict'

import type { WorkspaceStore } from '../workspaceStore'
import {
  __workspaceStorePartializeForTests,
  useWorkspaceStore,
} from '../workspaceStore'
import {
  createPluginsSlice,
  subscribePluginCatalogRefreshOnFocus,
  type PluginsSliceState,
} from './pluginsSlice'

function makeListenerTarget() {
  const handlers = new Map<string, () => void>()
  return {
    handlers,
    addEventListener(type: string, listener: () => void) {
      handlers.set(type, listener)
    },
    removeEventListener(type: string, _listener: () => void) {
      handlers.delete(type)
    },
  }
}

const okApi = {
  pluginsList: async () => ({
    ok: true as const,
    plugins: [
      { id: 'codex', displayName: 'Codex', source: 'bundled' as const, version: 1, binary: 'codex' },
      { id: 'opencode', displayName: 'OpenCode', source: 'user' as const, version: 1, binary: 'opencode' },
    ],
  }),
}

const carrier: PluginsSliceState = {
  pluginCatalogEntries: [],
  pluginCatalogStatus: 'loading',
  pluginCatalogError: null,
}

async function main(): Promise<void> {
  const slice = createPluginsSlice((mutator) => mutator(carrier), { getApi: () => okApi })
  await slice.refreshPluginCatalog()
  assert.equal(carrier.pluginCatalogStatus, 'ready')
  assert.equal(carrier.pluginCatalogError, null)
  assert.deepEqual(carrier.pluginCatalogEntries.map((entry) => entry.id), ['codex', 'opencode'])

  const failed = createPluginsSlice((mutator) => mutator(carrier), {
    getApi: () => ({
      pluginsList: async () => ({ ok: false as const, message: 'registry unavailable' }),
    }),
  })
  await failed.refreshPluginCatalog()
  assert.equal(carrier.pluginCatalogStatus, 'error')
  assert.equal(carrier.pluginCatalogError, 'registry unavailable')
  assert.deepEqual(carrier.pluginCatalogEntries, [])

  const missingApi = createPluginsSlice((mutator) => mutator(carrier), { getApi: () => null })
  await missingApi.refreshPluginCatalog()
  assert.equal(carrier.pluginCatalogStatus, 'error')
  assert.equal(carrier.pluginCatalogError, 'Plugin registry API is unavailable.')

  useWorkspaceStore.setState((state) => ({
    ...state,
    pluginCatalogEntries: [
      { id: 'codex', displayName: 'Codex', source: 'bundled', version: 1, binary: 'codex' },
    ],
    pluginCatalogStatus: 'ready',
    pluginCatalogError: null,
  }))
  const persisted = __workspaceStorePartializeForTests(useWorkspaceStore.getState() as WorkspaceStore) as Record<string, unknown>
  assert.equal('pluginCatalogEntries' in persisted, false)
  assert.equal('pluginCatalogStatus' in persisted, false)
  assert.equal('pluginCatalogError' in persisted, false)

  // --- T12: background focus re-sync ---------------------------------------
  // A background refresh must not flip the catalog to loading or wipe a working
  // catalog on a transient failure.
  const bgCarrier: PluginsSliceState = {
    pluginCatalogEntries: [
      { id: 'codex', displayName: 'Codex', source: 'bundled', version: 1, binary: 'codex' },
    ],
    pluginCatalogStatus: 'ready',
    pluginCatalogError: null,
  }
  const failingBackground = createPluginsSlice((mutator) => mutator(bgCarrier), {
    getApi: () => ({ pluginsList: async () => ({ ok: false as const, message: 'transient' }) }),
  })
  await failingBackground.refreshPluginCatalog({ background: true })
  assert.equal(bgCarrier.pluginCatalogStatus, 'ready', 'background failure keeps status ready')
  assert.equal(bgCarrier.pluginCatalogError, null, 'background failure does not surface an error')
  assert.deepEqual(
    bgCarrier.pluginCatalogEntries.map((entry) => entry.id),
    ['codex'],
    'background failure preserves the last-known-good catalog',
  )
  const okBackground = createPluginsSlice((mutator) => mutator(bgCarrier), { getApi: () => okApi })
  await okBackground.refreshPluginCatalog({ background: true })
  assert.deepEqual(
    bgCarrier.pluginCatalogEntries.map((entry) => entry.id),
    ['codex', 'opencode'],
    'background success updates the catalog in place',
  )
  assert.equal(bgCarrier.pluginCatalogStatus, 'ready')

  // --- T12: concurrent-refresh dedup ---------------------------------------
  let listCalls = 0
  let resolveList: (value: { ok: true; plugins: [] }) => void = () => {}
  const slowCarrier: PluginsSliceState = {
    pluginCatalogEntries: [],
    pluginCatalogStatus: 'loading',
    pluginCatalogError: null,
  }
  const slow = createPluginsSlice((mutator) => mutator(slowCarrier), {
    getApi: () => ({
      pluginsList: () => {
        listCalls += 1
        return new Promise<{ ok: true; plugins: [] }>((resolve) => {
          resolveList = resolve
        })
      },
    }),
  })
  const inflightA = slow.refreshPluginCatalog()
  const inflightB = slow.refreshPluginCatalog()
  assert.equal(inflightA, inflightB, 'concurrent refreshes share one in-flight promise')
  assert.equal(listCalls, 1, 'concurrent refreshes make a single plugins:list call')
  resolveList({ ok: true, plugins: [] })
  await inflightA
  const inflightC = slow.refreshPluginCatalog()
  assert.notEqual(inflightC, inflightA, 'a refresh after settle is a fresh call')
  resolveList({ ok: true, plugins: [] })
  await inflightC
  assert.equal(listCalls, 2, 'a refresh after settle calls plugins:list again')

  // --- T12: a foreground retry is not swallowed by an in-flight background --
  // refresh (it must still surface loading + error, not inherit the background
  // run's suppressed-error behavior).
  let modeCalls = 0
  const modeResolvers: Array<(value: { ok: false; message: string }) => void> = []
  const modeCarrier: PluginsSliceState = {
    pluginCatalogEntries: [
      { id: 'codex', displayName: 'Codex', source: 'bundled', version: 1, binary: 'codex' },
    ],
    pluginCatalogStatus: 'ready',
    pluginCatalogError: null,
  }
  const modeSlice = createPluginsSlice((mutator) => mutator(modeCarrier), {
    getApi: () => ({
      pluginsList: () => {
        modeCalls += 1
        return new Promise<{ ok: false; message: string }>((resolve) => {
          modeResolvers.push(resolve)
        })
      },
    }),
  })
  const backgroundRun = modeSlice.refreshPluginCatalog({ background: true })
  const foregroundRetry = modeSlice.refreshPluginCatalog()
  assert.notEqual(
    foregroundRetry,
    backgroundRun,
    'a foreground retry is not swallowed by an in-flight background refresh',
  )
  // Resolve the background run with a failure (background suppression is covered
  // by the standalone case above); the queued foreground run then takes over.
  modeResolvers[0]({ ok: false, message: 'background failure' })
  // The queued foreground run issues its own plugins:list call and flips to
  // loading — proving it ran with foreground semantics rather than inheriting
  // the background run.
  while (modeCalls < 2) await Promise.resolve()
  assert.equal(modeCalls, 2, 'foreground retry issues its own plugins:list call')
  assert.equal(modeCarrier.pluginCatalogStatus, 'loading', 'queued foreground retry flips to loading')
  // Its failure surfaces as an error state (not suppressed like the background run).
  modeResolvers[1]({ ok: false, message: 'foreground failure' })
  await foregroundRetry
  assert.equal(modeCarrier.pluginCatalogStatus, 'error', 'foreground retry surfaces an error state')
  assert.equal(modeCarrier.pluginCatalogError, 'foreground failure')

  // --- T12: focus / visibility subscription --------------------------------
  let refreshCount = 0
  const fakeWin = makeListenerTarget()
  const visibility = { state: 'visible' as DocumentVisibilityState }
  const fakeDoc = {
    ...makeListenerTarget(),
    get visibilityState() {
      return visibility.state
    },
  }
  const unsubscribe = subscribePluginCatalogRefreshOnFocus(
    () => {
      refreshCount += 1
    },
    { win: fakeWin, doc: fakeDoc },
  )
  assert.ok(fakeWin.handlers.has('focus'), 'focus listener registered')
  assert.ok(fakeDoc.handlers.has('visibilitychange'), 'visibilitychange listener registered')
  fakeWin.handlers.get('focus')?.()
  assert.equal(refreshCount, 1, 'window focus triggers a refresh')
  visibility.state = 'visible'
  fakeDoc.handlers.get('visibilitychange')?.()
  assert.equal(refreshCount, 2, 'becoming visible triggers a refresh')
  visibility.state = 'hidden'
  fakeDoc.handlers.get('visibilitychange')?.()
  assert.equal(refreshCount, 2, 'becoming hidden does not trigger a refresh')
  unsubscribe()
  assert.equal(fakeWin.handlers.has('focus'), false, 'focus listener removed on cleanup')
  assert.equal(fakeDoc.handlers.has('visibilitychange'), false, 'visibility listener removed on cleanup')

  console.log('pluginsSlice.test.ts: ok')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
