import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  DEFAULT_EDITOR_TREE_PREFS,
  EDITOR_TREE_PREFS_KEY,
  clampEditorTreeWidth,
  readEditorTreePrefs,
  writeEditorTreePrefs,
} from './editorTreePrefs'

// The editor window's tree column remembers whether it is shown and how wide
// it is — in its own key, and never by writing the shared settings envelope.

function memoryStorage() {
  const values = new Map<string, string>()
  const keys: string[] = []
  return {
    keys,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      keys.push(key)
      values.set(key, value)
    },
  }
}

test('defaults: shown, 260px', () => {
  assert.deepEqual(readEditorTreePrefs(memoryStorage()), { visible: true, width: 260 })
  assert.deepEqual(readEditorTreePrefs(null), DEFAULT_EDITOR_TREE_PREFS, 'no storage at all still reads')
})

test('the width is clamped to 180–480 on the way in and the way out', () => {
  assert.equal(clampEditorTreeWidth(90), 180)
  assert.equal(clampEditorTreeWidth(900), 480)
  assert.equal(clampEditorTreeWidth(Number.NaN), 260)
  const storage = memoryStorage()
  storage.setItem(EDITOR_TREE_PREFS_KEY, JSON.stringify({ visible: false, width: 9000 }))
  assert.deepEqual(readEditorTreePrefs(storage), { visible: false, width: 480 })
})

test('writes only its own key, and survives storage that throws', () => {
  const storage = memoryStorage()
  writeEditorTreePrefs({ visible: false, width: 300 }, storage)
  assert.deepEqual(storage.keys, [EDITOR_TREE_PREFS_KEY])
  assert.deepEqual(readEditorTreePrefs(storage), { visible: false, width: 300 })

  const throwing = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('quota')
    },
  }
  assert.doesNotThrow(() => writeEditorTreePrefs({ visible: true, width: 200 }, throwing))
  assert.deepEqual(readEditorTreePrefs(throwing), DEFAULT_EDITOR_TREE_PREFS)

  const garbage = memoryStorage()
  garbage.setItem(EDITOR_TREE_PREFS_KEY, '{not json')
  assert.deepEqual(readEditorTreePrefs(garbage), DEFAULT_EDITOR_TREE_PREFS)
})
