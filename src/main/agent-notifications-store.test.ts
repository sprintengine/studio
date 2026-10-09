import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { createAgentNotificationsStore } from './agent-notifications-store'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-notifications-'))
  dirs.push(dir)
  return dir
}

test('a profile that never chose shows a banner without sound', () => {
  const store = createAgentNotificationsStore({ resolveUserDataDir: profile })
  assert.equal(store.mode(), 'banner')
})

test('a choice is written and read back by the next launch', () => {
  const dir = profile()
  createAgentNotificationsStore({ resolveUserDataDir: () => dir }).set('banner-sound')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'agent-notifications.json'), 'utf8')), { mode: 'banner-sound' })
  assert.equal(createAgentNotificationsStore({ resolveUserDataDir: () => dir }).mode(), 'banner-sound')
})

test('a malformed file, or a value that is not a mode, reads as the default', () => {
  const dir = profile()
  writeFileSync(join(dir, 'agent-notifications.json'), '{"mode":"loud"}')
  assert.equal(createAgentNotificationsStore({ resolveUserDataDir: () => dir }).mode(), 'banner')
  writeFileSync(join(dir, 'agent-notifications.json'), 'not json')
  assert.equal(createAgentNotificationsStore({ resolveUserDataDir: () => dir }).mode(), 'banner')
})

test('a write of something that is not a mode is ignored', () => {
  const dir = profile()
  const store = createAgentNotificationsStore({ resolveUserDataDir: () => dir })
  store.set('off')
  store.set('loud')
  assert.equal(store.mode(), 'off')
})
