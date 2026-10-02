import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { CLIENT_TOOLSETS_FILENAME, createClientToolsetStore } from './client-toolset-store'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const dataDir = () => {
  const directory = mkdtempSync(join(tmpdir(), 'client-toolsets-'))
  directories.push(directory)
  return directory
}

test('bindings and grants survive a restart, in a file only its owner reads', () => {
  const directory = dataDir()
  const store = createClientToolsetStore({ dataDir: () => directory })
  store.bind('game', 'sla_game', 'Acme Game')
  store.setGranted('game', { workspaceId: 'ws-1', agentId: 'chat' }, true)
  const again = createClientToolsetStore({ dataDir: () => directory })
  assert.equal(again.binding('game')?.clientId, 'sla_game')
  assert.equal(again.binding('game')?.title, 'Acme Game')
  assert.deepEqual(again.grantsOf({ workspaceId: 'ws-1', agentId: 'chat' }), ['game'])
  if (process.platform !== 'win32')
    assert.equal(statSync(join(directory, CLIENT_TOOLSETS_FILENAME)).mode & 0o777, 0o600)
  assert.throws(() => again.bind('game', 'sla_other', 'Other'), /bound to another client/)
  assert.deepEqual(again.forgetClient('sla_game'), ['game'])
  const after = JSON.parse(readFileSync(join(directory, CLIENT_TOOLSETS_FILENAME), 'utf8')) as { bindings: unknown[] }
  assert.deepEqual(after.bindings, [])
})

test('an unreadable file binds nothing, and an entry in the wrong shape is skipped', () => {
  const directory = dataDir()
  writeFileSync(join(directory, CLIENT_TOOLSETS_FILENAME), '{ not json')
  const logs: string[] = []
  const store = createClientToolsetStore({ dataDir: () => directory, log: (message) => logs.push(message) })
  assert.deepEqual(store.bindings(), [])
  assert.equal(logs.length, 1)
  writeFileSync(
    join(directory, CLIENT_TOOLSETS_FILENAME),
    JSON.stringify({
      bindings: [
        { toolset: 'Bad_Name', clientId: 'x' },
        { toolset: 'ok-name', clientId: 'sla_1' },
      ],
    }),
  )
  assert.deepEqual(
    createClientToolsetStore({ dataDir: () => directory })
      .bindings()
      .map((binding) => binding.toolset),
    ['ok-name'],
  )
})
