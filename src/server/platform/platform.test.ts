import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import {
  createNodeStudioPlatform,
  installedStudioPlatform,
  installStudioPlatform,
  resetStudioPlatform,
  studioPlatform,
} from './platform'
import type { StudioNotice } from './notifier'

const directories: string[] = []
afterEach(() => {
  resetStudioPlatform()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('reading the platform before one is installed is a wiring bug, said out loud', () => {
  assert.equal(installedStudioPlatform(), null)
  assert.throws(() => studioPlatform(), /No Studio platform is installed/)
})

test('the node platform seals with a key file in the data directory and fans out to local listeners', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-platform-'))
  directories.push(dataDir)
  const platform = createNodeStudioPlatform({ dataDir, logsDir: join(dataDir, 'logs'), version: '1.2.3' })
  installStudioPlatform(platform)
  assert.equal(studioPlatform(), platform)
  assert.equal(installedStudioPlatform(), platform)

  assert.equal(platform.paths.dataDir(), dataDir)
  assert.equal(platform.identity.version(), '1.2.3')
  assert.equal(platform.secrets.open(platform.secrets.seal('value')), 'value')
  assert.equal(
    createNodeStudioPlatform({ dataDir, version: '1.2.3' }).secrets.open(platform.secrets.seal('again')),
    'again',
    'a second server on the same data directory opens what the first sealed',
  )

  const published: Array<[string, unknown]> = []
  const stop = platform.clients.subscribe((topic, payload) => published.push([topic, payload]))
  platform.clients.subscribe(() => {
    throw new Error('one listener failing')
  })
  platform.clients.publish('scheduled-agents:changed', [{ id: 'a' }])
  stop()
  platform.clients.publish('scheduled-agents:changed', [])
  assert.deepEqual(published, [['scheduled-agents:changed', [{ id: 'a' }]]])

  const notices: StudioNotice[] = []
  platform.notifier.subscribe((notice) => notices.push(notice))
  platform.notifier.notify({ key: 'pair', title: 'Pairing request', body: 'From build-box' })
  assert.deepEqual(notices, [{ key: 'pair', title: 'Pairing request', body: 'From build-box' }])
})
