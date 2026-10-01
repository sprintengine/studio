import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { iconSetForChannel, useChannelIcons } from './use-channel-icons.mjs'

function resourcesWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-icons-'))
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents)
  return dir
}

const BOTH_SETS = {
  'icon.icns': 'stable icns',
  'icon.ico': 'stable ico',
  'icon.png': 'stable png',
  'icon-nightly.icns': 'nightly icns',
  'icon-nightly.ico': 'nightly ico',
  'icon-nightly.png': 'nightly png',
}

test('only the nightly channel has its own icon set', () => {
  assert.equal(iconSetForChannel('nightly'), 'icon-nightly')
  assert.equal(iconSetForChannel('latest'), null)
  assert.equal(iconSetForChannel('stable'), null)
  assert.equal(iconSetForChannel('preview'), null)
})

test('a nightly packages with the night-sky icon on every platform', () => {
  const dir = resourcesWith(BOTH_SETS)
  try {
    const written = useChannelIcons('nightly', dir)
    assert.equal(written.length, 3)
    for (const extension of ['icns', 'ico', 'png']) {
      assert.equal(readFileSync(join(dir, `icon.${extension}`), 'utf8'), `nightly ${extension}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stable packages the committed icon untouched', () => {
  const dir = resourcesWith(BOTH_SETS)
  try {
    assert.deepEqual(useChannelIcons('latest', dir), [])
    for (const extension of ['icns', 'ico', 'png']) {
      assert.equal(readFileSync(join(dir, `icon.${extension}`), 'utf8'), `stable ${extension}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a nightly with a missing icon fails rather than shipping the stable one', () => {
  const { 'icon-nightly.ico': _omitted, ...incomplete } = BOTH_SETS
  const dir = resourcesWith(incomplete)
  try {
    assert.throws(() => useChannelIcons('nightly', dir), /missing icon-nightly\.ico/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the committed nightly set exists beside the stable one', () => {
  const resources = new URL('../../resources/', import.meta.url)
  for (const extension of ['icns', 'ico', 'png']) {
    const nightly = readFileSync(new URL(`icon-nightly.${extension}`, resources))
    const stable = readFileSync(new URL(`icon.${extension}`, resources))
    assert.ok(nightly.length > 0, `icon-nightly.${extension} is empty`)
    assert.notDeepEqual(nightly, stable, `icon-nightly.${extension} is the stable icon`)
  }
})
