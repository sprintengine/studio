/**
 * What the window-material mirror means on each platform, read before any
 * renderer exists: the material a new window is created with, and the opaque
 * colour it paints first.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { normalizeWindowCanvasColor, resolveWindowMaterial } from './window-material-store'

test('glass is the macOS default and resolves to tinted where there is no vibrancy', () => {
  assert.equal(resolveWindowMaterial(undefined, 'darwin'), 'glass')
  assert.equal(resolveWindowMaterial('glass', 'darwin'), 'glass')
  assert.equal(resolveWindowMaterial(undefined, 'win32'), 'tinted')
  assert.equal(resolveWindowMaterial('glass', 'win32'), 'tinted')
  assert.equal(resolveWindowMaterial('glass', 'linux'), 'tinted')
})

test('an explicit tinted or solid is honoured on every platform', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    assert.equal(resolveWindowMaterial('tinted', platform), 'tinted')
    assert.equal(resolveWindowMaterial('solid', platform), 'solid')
  }
})

test('an unknown material takes the platform default', () => {
  assert.equal(resolveWindowMaterial('frosted', 'darwin'), 'glass')
  assert.equal(resolveWindowMaterial(42, 'linux'), 'tinted')
})

test('the canvas colour is kept only as an opaque #rrggbb', () => {
  assert.equal(normalizeWindowCanvasColor('#EAEEF2'), '#eaeef2')
  assert.equal(normalizeWindowCanvasColor('#08080c'), '#08080c')
  assert.equal(normalizeWindowCanvasColor('#08080c80'), undefined)
  assert.equal(normalizeWindowCanvasColor('rgb(8, 8, 12)'), undefined)
  assert.equal(normalizeWindowCanvasColor(undefined), undefined)
})
