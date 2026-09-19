import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('modelPermissionPresets', async () => {
  // The per-row permission preset store: what a model row spawns on, remembered
  // against that row rather than once for the whole app (owner, 2026-09-05). The
  // picker's footer writes it and every spawn path resolves it, so the rules that
  // matter here are the ones no surface can restate — the fallback, the isolation
  // between rows, and what a store written by another build does.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.localStorage = dom.window.localStorage

  const STORAGE_KEY = 'sprintengine.model-permission-presets'

  // Seeded BEFORE the module is imported: the store reads localStorage once,
  // lazily, so this is the only way to exercise the hydrate path a real app start
  // takes. Everything after runs against the store that read it.
  dom.window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      'claude-code:claude-opus-5': 'yolo',
      'claude-code:claude-sonnet-5': 'auto',
      '': 'bypass',
    }),
  )

  async function main(): Promise<void> {
    const {
      __resetModelPermissionPresetsForTest,
      resolveModelPermissionPreset,
      setModelPermissionPreset,
      storedModelPermissionPreset,
    } = await import('./modelPermissionPresets')
    const { modelFavouriteKey } = await import('./modelFavourites')

    // A value this build does not recognise is dropped rather than carried: an
    // unknown preset would resolve to no flag at all at spawn time, which is not
    // what the row claims to say. Its neighbours survive the drop.
    assert.equal(
      resolveModelPermissionPreset('claude-code', 'claude-opus-5', 'manual'),
      'manual',
      'an unrecognised preset falls back rather than launching on nothing',
    )
    assert.equal(
      resolveModelPermissionPreset('claude-code', 'claude-sonnet-5', 'manual'),
      'auto',
      'its neighbour survives',
    )

    __resetModelPermissionPresetsForTest()

    // A row nobody has set resolves to the app-wide default, so nothing moves
    // until someone chooses in the picker.
    assert.equal(storedModelPermissionPreset('claude-code', 'claude-opus-5'), undefined)
    assert.equal(resolveModelPermissionPreset('claude-code', 'claude-opus-5', 'manual'), 'manual')

    // Setting one row moves that row and nothing else — the whole point of the
    // move off a single app-wide value.
    setModelPermissionPreset('claude-code', 'claude-opus-5', 'bypass')
    assert.equal(resolveModelPermissionPreset('claude-code', 'claude-opus-5', 'manual'), 'bypass')
    assert.equal(
      resolveModelPermissionPreset('claude-code', 'claude-sonnet-5', 'manual'),
      'manual',
      'a sibling model on the same CLI keeps the default',
    )
    assert.equal(
      resolveModelPermissionPreset('codex', 'claude-opus-5', 'manual'),
      'manual',
      'and so does the same model id on another CLI — the row is the pair, not the model',
    )

    // The CLI's own default-model row is a row like any other, keyed by the same
    // identity the stars use, so a row has one id across everything the picker
    // remembers about it.
    setModelPermissionPreset('claude-code', null, 'auto')
    assert.equal(resolveModelPermissionPreset('claude-code', null, 'manual'), 'auto')
    assert.equal(
      resolveModelPermissionPreset('claude-code', 'claude-opus-5', 'manual'),
      'bypass',
      'setting the default row leaves the named models alone',
    )
    const raw = JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, string>
    assert.equal(raw[modelFavouriteKey('claude-code', null)], 'auto', 'stored under the star’s own key')

    // No CLI is no row: a terminal and a conversation launch nothing that reads a
    // permission flag, so there is nothing to store against them and nothing to
    // read back.
    setModelPermissionPreset(null, 'claude-opus-5', 'bypass')
    assert.equal(storedModelPermissionPreset(null, 'claude-opus-5'), undefined)
    assert.equal(resolveModelPermissionPreset(null, 'claude-opus-5', 'manual'), 'manual')

    // The reset seam empties the PERSISTED store, not just the cache — dropping
    // the cache alone re-reads whatever was written last, which is how a preset
    // set in one test leaks into the next.
    __resetModelPermissionPresetsForTest()
    assert.equal(storedModelPermissionPreset('claude-code', null), undefined)
    assert.equal(dom.window.localStorage.getItem(STORAGE_KEY), '{}')

    console.log('modelPermissionPresets.test.ts passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
