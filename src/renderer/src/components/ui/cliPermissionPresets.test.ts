import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

// The per-CLI permission preset store: what every model of a CLI spawns on,
// remembered once for that CLI (owner ruling 2026-09-24). The picker's footer
// writes it and every spawn path resolves it, so the rules that matter here are
// the ones no surface can restate — the fallback, one value across a CLI's
// models, the isolation between CLIs, and what a store written by another build
// does.

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.localStorage = dom.window.localStorage

const STORAGE_KEY = 'sprintengine.cli-permission-presets'
const RETIRED_KEY = 'sprintengine.model-permission-presets'

// Seeded BEFORE the module is imported: the store reads localStorage once,
// lazily, so this is the only way to exercise the hydrate path a real app start
// takes.
dom.window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'claude-code': 'yolo', codex: 'auto', '': 'bypass' }))
dom.window.localStorage.setItem(RETIRED_KEY, JSON.stringify({ 'claude-code:claude-opus-5': 'bypass' }))

const store = await import('./cliPermissionPresets')

test('a stored value this build does not recognise falls back, and its neighbours survive', () => {
  assert.equal(store.resolveCliPermissionPreset('claude-code', 'manual'), 'manual')
  assert.equal(store.resolveCliPermissionPreset('codex', 'manual'), 'auto')
})

test('the retired per-model map is not adopted and is removed from the profile', () => {
  assert.equal(dom.window.localStorage.getItem(RETIRED_KEY), null)
  assert.equal(store.storedCliPermissionPreset('claude-code'), undefined)
})

test('a CLI nobody has set resolves to the app-wide default', () => {
  store.__resetCliPermissionPresetsForTest()
  assert.equal(store.storedCliPermissionPreset('claude-code'), undefined)
  assert.equal(store.resolveCliPermissionPreset('claude-code', 'manual'), 'manual')
})

test('setting a CLI moves that CLI and no other', () => {
  store.__resetCliPermissionPresetsForTest()
  store.setCliPermissionPreset('claude-code', 'bypass')
  assert.equal(store.resolveCliPermissionPreset('claude-code', 'manual'), 'bypass')
  assert.equal(store.resolveCliPermissionPreset('codex', 'manual'), 'manual', 'Codex keeps its own value')
  store.setCliPermissionPreset('codex', 'auto')
  assert.equal(store.resolveCliPermissionPreset('claude-code', 'manual'), 'bypass', 'and Codex cannot move Claude')
})

test('the choice survives a reload from storage, the way an app restart reads it', () => {
  store.__resetCliPermissionPresetsForTest()
  store.setCliPermissionPreset('claude-code', 'bypass')
  store.setCliPermissionPreset('codex', 'auto')
  assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY) ?? '{}'), {
    'claude-code': 'bypass',
    codex: 'auto',
  })
  store.__reloadCliPermissionPresetsForTest()
  assert.equal(store.storedCliPermissionPreset('claude-code'), 'bypass')
  assert.equal(store.storedCliPermissionPreset('codex'), 'auto')
})

test('no CLI stores nothing and reads the fallback', () => {
  store.__resetCliPermissionPresetsForTest()
  store.setCliPermissionPreset(null, 'bypass')
  assert.equal(store.storedCliPermissionPreset(null), undefined)
  assert.equal(store.resolveCliPermissionPreset(null, 'manual'), 'manual')
  assert.equal(dom.window.localStorage.getItem(STORAGE_KEY), '{}')
})
