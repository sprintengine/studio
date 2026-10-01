import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { test } from 'vitest'

import { TAILNET_DEVICES_FILENAME } from './automation/tailnet/tailnet-devices'
import { RETIRED_RELAY_STATE_FILE_NAME, removeRetiredRelayState } from './retired-relay-state'

async function userData(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sprintengine-retired-relay-'))
}

test('removes the relay state file and reports what it held', async () => {
  const dir = await userData()
  await writeFile(
    join(dir, RETIRED_RELAY_STATE_FILE_NAME),
    JSON.stringify({
      enabled: true,
      relayUrl: 'https://relay.example.com',
      desktopInstanceId: 'mdi_example',
      pairedDevices: [{ deviceId: 'device_1' }, { deviceId: 'device_2' }],
      pushRegistrations: [{ registrationId: 'push_1' }],
    }),
  )

  const result = await removeRetiredRelayState(dir)

  assert.deepEqual(result, { outcome: 'removed', relayPairings: 2, pushRegistrations: 1 })
  assert.deepEqual(await readdir(dir), [])
})

test('never touches the tailnet pairings', async () => {
  const dir = await userData()
  const tailnetDevices = JSON.stringify({ devices: [{ id: 'dev_android-phone' }] })
  await writeFile(join(dir, TAILNET_DEVICES_FILENAME), tailnetDevices)
  await writeFile(join(dir, RETIRED_RELAY_STATE_FILE_NAME), '{}')

  await removeRetiredRelayState(dir)

  assert.equal(await readFile(join(dir, TAILNET_DEVICES_FILENAME), 'utf8'), tailnetDevices)
  assert.deepEqual(await readdir(dir), [TAILNET_DEVICES_FILENAME])
})

test('is a no-op once the file is gone, so running it every launch is safe', async () => {
  const dir = await userData()
  assert.deepEqual(await removeRetiredRelayState(dir), { outcome: 'absent' })
})

test('a file that no longer parses is still removed', async () => {
  const dir = await userData()
  await writeFile(join(dir, RETIRED_RELAY_STATE_FILE_NAME), 'not json')
  assert.deepEqual(await removeRetiredRelayState(dir), { outcome: 'removed', relayPairings: 0, pushRegistrations: 0 })
  assert.deepEqual(await readdir(dir), [])
})
