import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTailnetDeviceStore, TAILNET_DEVICES_FILENAME } from './tailnet-devices'

// A paired-devices file that could not be read is never replaced by what one
// run knows: the next pairing would forget every device paired before.

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-devices-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const mint = { name: 'android-phone', scopes: ['workspace:read' as const], origin: { kind: 'code' as const, by: null } }

test('a devices file that cannot be read is not written over by the next pairing', () => {
  if (process.platform === 'win32') return
  withDir((dir) => {
    const path = join(dir, TAILNET_DEVICES_FILENAME)
    const original = JSON.stringify({ version: 1, devices: [] }) + ' '
    writeFileSync(path, original, { mode: 0o000 })
    const store = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
    store.mintDevice(mint as never)
    assert.equal(store.listDevices().length, 1, 'the new device works for the session')
    chmodSync(path, 0o600)
    assert.equal(readFileSync(path, 'utf8'), original)
  })
})

test('a devices file that is not valid JSON is kept aside before the next pairing is written', () => {
  withDir((dir) => {
    const path = join(dir, TAILNET_DEVICES_FILENAME)
    writeFileSync(path, '{"version":1,"devices":[', { mode: 0o600 })
    const store = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
    store.mintDevice(mint as never)
    const aside = readdirSync(dir).filter((name) => name.startsWith(`${TAILNET_DEVICES_FILENAME}.invalid-`))
    assert.equal(aside.length, 1)
    assert.equal(readFileSync(join(dir, aside[0]!), 'utf8'), '{"version":1,"devices":[')
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { devices: unknown[] }).devices.length, 1)
  })
})

test('an invalid devices file deleted since it was read leaves the next pairing free to write a new one', () => {
  withDir((dir) => {
    const path = join(dir, TAILNET_DEVICES_FILENAME)
    writeFileSync(path, '{"version":1,"devices":[', { mode: 0o600 })
    const store = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
    unlinkSync(path)
    store.mintDevice(mint as never)
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { devices: unknown[] }).devices.length, 1)
  })
})

test('an invalid devices file that cannot be moved aside is left alone, and pairing still works', () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return
  withDir((dir) => {
    const path = join(dir, TAILNET_DEVICES_FILENAME)
    writeFileSync(path, '{"version":1,"devices":[', { mode: 0o600 })
    const store = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
    chmodSync(dir, 0o500)
    try {
      store.mintDevice(mint as never)
      store.mintDevice(mint as never)
    } finally {
      chmodSync(dir, 0o700)
    }
    assert.equal(store.listDevices().length, 2, 'both devices work for the session')
    assert.equal(readFileSync(path, 'utf8'), '{"version":1,"devices":[')
  })
})
