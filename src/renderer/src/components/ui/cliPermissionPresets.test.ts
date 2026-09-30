import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  LEGACY_CLI_PERMISSION_PRESETS_KEY,
  RETIRED_PER_MODEL_PRESETS_KEY,
  migrateLegacyCliPermissionPresets,
} from '../../store/legacyCliPermissionPresets'
import type { AgentLaunchSettingsPatch } from '../../../../shared/launch-settings'

// The per-CLI permission preset: what every model of a CLI spawns on,
// remembered once for that CLI (owner ruling 2026-09-24). The picker's footer
// writes it and every spawn path resolves it, so the rules that matter here are
// the ones no surface can restate: the fallback, one value across a CLI's
// models, the isolation between CLIs, and the handover of the map a profile
// kept in localStorage before main owned it.

const store = await import('./cliPermissionPresets')
const { useWorkspaceStore } = await import('../../store/workspaceStore')

test('a CLI nobody has set resolves to the app-wide default', () => {
  store.__resetCliPermissionPresetsForTest()
  assert.equal(store.storedCliPermissionPreset('claude-code'), undefined)
  assert.equal(store.resolveCliPermissionPreset('claude-code', 'none'), 'none')
})

test('setting a CLI moves that CLI and no other', () => {
  store.__resetCliPermissionPresetsForTest()
  store.setCliPermissionPreset('claude-code', 'none')
  assert.equal(store.resolveCliPermissionPreset('claude-code', 'bypass'), 'none')
  assert.equal(store.resolveCliPermissionPreset('codex', 'bypass'), 'bypass', 'Codex keeps its own value')
  store.setCliPermissionPreset('codex', 'bypass')
  assert.equal(store.storedCliPermissionPreset('codex'), 'bypass')
  assert.equal(store.resolveCliPermissionPreset('claude-code', 'bypass'), 'none', 'and Codex cannot move Claude')
})

test('the map lives in the launch-settings read model that main fills', () => {
  store.__resetCliPermissionPresetsForTest()
  store.setCliPermissionPreset('codex', 'none')
  assert.deepEqual(useWorkspaceStore.getState().appSettings.cliPermissionPresets, { codex: 'none' })
  // Main's broadcast, from another window's pick, lands in the same place.
  useWorkspaceStore.setState((state) => ({
    appSettings: { ...state.appSettings, cliPermissionPresets: { codex: 'none', 'claude-code': 'bypass' } },
  }))
  assert.equal(store.storedCliPermissionPreset('claude-code'), 'bypass')
})

test('no CLI stores nothing and reads the fallback', () => {
  store.__resetCliPermissionPresetsForTest()
  store.setCliPermissionPreset(null, 'bypass')
  assert.equal(store.storedCliPermissionPreset(null), undefined)
  assert.equal(store.resolveCliPermissionPreset(null, 'none'), 'none')
  assert.deepEqual(useWorkspaceStore.getState().appSettings.cliPermissionPresets, {})
})

function memoryStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries))
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => {
      map.delete(key)
    },
  }
}

test('the localStorage map is handed to main once, for the CLIs main holds nothing for', async () => {
  const storage = memoryStorage({
    [LEGACY_CLI_PERMISSION_PRESETS_KEY]: JSON.stringify({
      'claude-code': 'bypass',
      codex: 'auto',
      // Manual and Auto the old store kept arrive as themselves.
      grok: 'manual',
      cursor: 'auto',
      gemini: 'yolo',
      '': 'bypass',
    }),
    [RETIRED_PER_MODEL_PRESETS_KEY]: JSON.stringify({ 'claude-code:claude-opus-5': 'bypass' }),
  })
  const patches: AgentLaunchSettingsPatch[] = []
  await migrateLegacyCliPermissionPresets({
    storage,
    // Another window has already chosen for Codex since the upgrade.
    held: async () => ({ codex: 'bypass' }),
    update: async (patch) => {
      patches.push(patch)
      return true
    },
  })
  assert.deepEqual(
    patches,
    [{ cliPermissionPresets: { 'claude-code': 'bypass', grok: 'manual', cursor: 'auto' } }],
    'Codex keeps the newer choice, manual and auto arrive as themselves, and a value this build does not recognise is not carried',
  )
  assert.equal(storage.map.size, 0, 'both old keys are gone once main has it on disk')
})

test('the localStorage map stays when main could not keep the handover on disk', async () => {
  const storage = memoryStorage({ [LEGACY_CLI_PERMISSION_PRESETS_KEY]: JSON.stringify({ codex: 'auto' }) })
  await migrateLegacyCliPermissionPresets({ storage, held: async () => ({}), update: async () => false })
  assert.ok(storage.map.has(LEGACY_CLI_PERMISSION_PRESETS_KEY), 'the next boot offers it again')
})

test('a profile with nothing to hand over sends nothing', async () => {
  let calls = 0
  const update = async () => {
    calls += 1
    return true
  }
  await migrateLegacyCliPermissionPresets({ storage: memoryStorage({}), held: async () => ({}), update })
  const covered = memoryStorage({ [LEGACY_CLI_PERMISSION_PRESETS_KEY]: JSON.stringify({ codex: 'auto' }) })
  await migrateLegacyCliPermissionPresets({ storage: covered, held: async () => ({ codex: 'none' }), update })
  assert.equal(calls, 0)
  assert.equal(covered.map.size, 0, 'a map main already covers is simply dropped')
})
