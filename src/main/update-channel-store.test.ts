import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { channelForVersion, createUpdateChannelStore, isUpdateTrack, resolveUpdateTrack } from './update-channel-store'

const dirs: string[] = []
function userData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'update-channel-store-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('a build follows the channel its own version names', () => {
  assert.equal(channelForVersion('0.5.2-nightly.20260923.41'), 'nightly')
  assert.equal(channelForVersion('v0.5.2-nightly.20260923.41'), 'nightly')
  assert.equal(channelForVersion('0.5.2'), 'stable')
  // The retired preview train's bridge build is a stable install: its next
  // update is the latest stable.
  assert.equal(channelForVersion('0.5.1-preview.20260923.7'), 'stable')
  assert.equal(channelForVersion('0.5.1-nightlyish.1'), 'stable')
  assert.equal(channelForVersion('0.0.0'), 'stable')
})

test('a saved choice wins over the version', () => {
  assert.equal(resolveUpdateTrack('0.5.2', null), 'stable')
  assert.equal(resolveUpdateTrack('0.5.2', 'nightly'), 'nightly')
  assert.equal(resolveUpdateTrack('0.6.0-nightly.20260923.41', null), 'nightly')
  assert.equal(resolveUpdateTrack('0.6.0-nightly.20260923.41', 'stable'), 'stable')
})

test('isUpdateTrack accepts the two trains and nothing else', () => {
  assert.equal(isUpdateTrack('stable'), true)
  assert.equal(isUpdateTrack('nightly'), true)
  for (const value of ['preview', 'dev', 'latest', '', null, undefined, 1, {}])
    assert.equal(isUpdateTrack(value), false)
})

test('no file, a malformed file, or an unknown channel all read as no choice', () => {
  const dir = userData()
  assert.equal(createUpdateChannelStore({ resolveUserDataDir: () => dir }).get(), null)
  writeFileSync(join(dir, 'update-channel.json'), '{not json')
  assert.equal(createUpdateChannelStore({ resolveUserDataDir: () => dir }).get(), null)
  writeFileSync(join(dir, 'update-channel.json'), JSON.stringify({ channel: 'preview' }))
  assert.equal(createUpdateChannelStore({ resolveUserDataDir: () => dir }).get(), null)
  writeFileSync(join(dir, 'update-channel.json'), JSON.stringify(['nightly']))
  assert.equal(createUpdateChannelStore({ resolveUserDataDir: () => dir }).get(), null)
})

test('a choice is persisted under userData and read back by the next session', () => {
  const dir = userData()
  const store = createUpdateChannelStore({ resolveUserDataDir: () => dir })
  store.set('nightly')
  assert.equal(store.get(), 'nightly')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'update-channel.json'), 'utf8')), { channel: 'nightly' })
  assert.equal(createUpdateChannelStore({ resolveUserDataDir: () => dir }).get(), 'nightly')
  store.set('stable')
  assert.equal(createUpdateChannelStore({ resolveUserDataDir: () => dir }).get(), 'stable')
  assert.throws(() => store.set('preview' as never), /Unknown update channel/)
})

test('a write that fails still applies for the session and says so', () => {
  const warnings: string[] = []
  const store = createUpdateChannelStore({
    resolveUserDataDir: () => join(userData(), 'missing', 'nested'),
    logDiagnostic: (input) => warnings.push(input.title),
  })
  store.set('nightly')
  assert.equal(store.get(), 'nightly')
  assert.deepEqual(warnings, ['Update channel not persisted'])
  // Unchanged: no second write, no second warning.
  store.set('nightly')
  assert.equal(warnings.length, 1)
})
