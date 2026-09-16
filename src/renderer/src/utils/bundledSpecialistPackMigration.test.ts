import assert from 'node:assert/strict'

import { useWorkspaceStore } from '../store/workspaceStore'
import type { RoleInstallResult } from '../../../shared/sprintengine/role-manifest'
import { runBundledSpecialistPackMigration } from './bundledSpecialistPackMigration'
import { bindSprintEngineIpc } from '../modules/sprint-engine-ipc'

const OK: RoleInstallResult = { ok: true, installedRoles: ['tester'], installedSkills: ['tester'], rejected: [] }
const FAIL: RoleInstallResult = { ok: false, installedRoles: [], installedSkills: [], rejected: [], message: 'boom' }

let installCalls = 0
let installResult: RoleInstallResult = OK

// The migration reads window.api in a renderer; stub it for the node test. No
// folder-backed workspace is seeded, so the post-install registry refresh
// early-returns and never needs readSprintEngineRegistryRoles.
const memoryStore = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (key: string): string | null => memoryStore.get(key) ?? null,
    setItem: (key: string, value: string): void => void memoryStore.set(key, value),
    removeItem: (key: string): void => void memoryStore.delete(key),
  },
  api: {},
}
bindSprintEngineIpc({
  installBundledSpecialistPack: async (): Promise<RoleInstallResult> => {
    installCalls += 1
    return installResult
  },
} as never)

function seedPacks(disabled: string[], migratedBundledPack: boolean): void {
  const state = useWorkspaceStore.getState()
  useWorkspaceStore.setState({
    appSettings: { ...state.appSettings, specialistPacks: { disabled, migratedBundledPack } },
  })
}

function migrated(): boolean {
  return useWorkspaceStore.getState().appSettings.specialistPacks.migratedBundledPack
}

// A fresh profile (this node load has no persisted state → 'fresh' hydration)
// keeps the default guard true, so the migration installs nothing — the
// raw-first experience is preserved for genuinely new installs.
installCalls = 0
await runBundledSpecialistPackMigration()
assert.equal(migrated(), true, 'a fresh profile hydrates with the guard already set')
assert.equal(installCalls, 0, 'a fresh profile installs nothing')

// Already evaluated → no-op, install never called.
installCalls = 0
seedPacks([], true)
await runBundledSpecialistPackMigration()
assert.equal(installCalls, 0, 'an already-migrated profile does not install')

// Enabled (pack id absent from disabled) and not yet migrated → install once,
// then record the migration ran.
installCalls = 0
installResult = OK
seedPacks([], false)
await runBundledSpecialistPackMigration()
assert.equal(installCalls, 1, 'an enabled, unmigrated profile installs once')
assert.equal(migrated(), true, 'a successful install records the migration')

// Disabled (pack id present) → install nothing, still record the migration so
// it never re-evaluates.
installCalls = 0
seedPacks(['multicode-specialists'], false)
await runBundledSpecialistPackMigration()
assert.equal(installCalls, 0, 'a disabled profile installs nothing')
assert.equal(migrated(), true, 'a disabled profile still records the migration')

// Install failure → leave the guard unset so a fixed build retries.
installCalls = 0
installResult = FAIL
seedPacks([], false)
await runBundledSpecialistPackMigration()
assert.equal(installCalls, 1, 'a failing install is attempted')
assert.equal(migrated(), false, 'a failed install does not record the migration')

console.log('bundledSpecialistPackMigration.test.ts: ok')
