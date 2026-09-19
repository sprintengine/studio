/**
 * MC-2156 — the renderer half of the background-mode mirror. Main reads this
 * setting when there is no renderer left to ask, so the push has to reach it
 * while a window is still up: on mount, and on every flip.
 */
import assert from 'node:assert/strict'

// Imported AFTER the fake window is installed.
import { useWorkspaceStore } from '../store/workspaceStore'
import { initBackgroundModeSync } from './backgroundModeSync'
import { test } from 'vitest'

test('backgroundModeSync', async () => {
  type FakeApi = { pushes: boolean[] }

  function installFakeApi(): FakeApi {
    const fake: FakeApi = { pushes: [] }
    const api = {
      setBackgroundMode: (enabled: boolean): Promise<void> => {
        fake.pushes.push(enabled)
        return Promise.resolve()
      },
    }
    ;(globalThis as { window?: unknown }).window = { api }
    return fake
  }

  const fakeApi = installFakeApi()

  function main(): void {
    const dispose = initBackgroundModeSync()
    try {
      assertMountPushesTheStoredValue()
      assertFlipsReachMainWithoutRestart()
      assertUnrelatedStoreWritesDoNotPush()
    } finally {
      dispose()
    }
    console.log('background-mode-sync tests passed')
  }

  // (1) The mount push runs even when the setting is off: another window (or an
  // import) may have turned it off while main still holds the old `true`.
  function assertMountPushesTheStoredValue(): void {
    assert.deepEqual(fakeApi.pushes, [false], 'the default-off value is pushed, not skipped')
  }

  // (2) The acceptance case: flipping the switch is in main's next read, no
  // restart involved.
  function assertFlipsReachMainWithoutRestart(): void {
    useWorkspaceStore.getState().setKeepRunningInBackground(true)
    assert.deepEqual(fakeApi.pushes, [false, true])
    assert.equal(useWorkspaceStore.getState().appSettings.keepRunningInBackground, true)

    useWorkspaceStore.getState().setKeepRunningInBackground(false)
    assert.deepEqual(fakeApi.pushes, [false, true, false], 'turning it back off must reach main too')
  }

  // (3) The store notifies on every change; only this setting pushes.
  function assertUnrelatedStoreWritesDoNotPush(): void {
    const before = fakeApi.pushes.length
    useWorkspaceStore.getState().setKeepRunningInBackground(false)
    useWorkspaceStore.getState().setSidebarCollapsed(true)
    assert.equal(fakeApi.pushes.length, before, 'an unchanged value is not re-pushed')
  }

  main()
})
