import assert from 'node:assert/strict'
import { test } from 'vitest'
import { effectiveWindowMaterial, isWindowMaterial } from './appTheme'

test('tinted is a window material beside solid and glass', () => {
  assert.equal(isWindowMaterial('tinted'), true)
  assert.equal(isWindowMaterial('glass'), true)
  assert.equal(isWindowMaterial('solid'), true)
  assert.equal(isWindowMaterial('frosted'), false)
})

test('a stored glass paints glass on macOS and tinted everywhere else', () => {
  assert.equal(effectiveWindowMaterial('glass', 'darwin'), 'glass')
  assert.equal(effectiveWindowMaterial('glass', 'win32'), 'tinted')
  assert.equal(effectiveWindowMaterial('glass', 'linux'), 'tinted')
  assert.equal(effectiveWindowMaterial('glass', undefined), 'tinted')
})

test('an explicit tinted or solid is kept on every platform', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(effectiveWindowMaterial('tinted', platform), 'tinted')
    assert.equal(effectiveWindowMaterial('solid', platform), 'solid')
  }
})
