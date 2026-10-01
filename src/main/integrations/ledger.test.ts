import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import {
  createIntegrationLedger,
  hostIdForPath,
  installIntegrationLedger,
  ledgerKey,
  recordIntegrationWrite,
  type IntegrationWrite,
} from './ledger'

afterEach(() => installIntegrationLedger(null))

async function ledgerAt(label: string, mirror?: string) {
  const dir = await mkdtemp(join(tmpdir(), `sprintengine-ledger-${label}-`))
  let tick = 0
  const ledger = createIntegrationLedger({
    path: join(dir, 'integration-ledger.json'),
    now: () => new Date(Date.UTC(2026, 8, 25, 12, 0, tick++)),
    ...(mirror ? { mirrorPathFor: (hostId: string) => (hostId === 'wsl:Ubuntu' ? mirror : null) } : {}),
  })
  return { dir, ledger, file: join(dir, 'integration-ledger.json') }
}

const hook: IntegrationWrite = {
  kind: 'agent-state-hooks',
  path: '/Users/dev/app/.codex/config.toml',
  marker: 'toml-block',
  hostId: 'local',
  cli: 'codex',
  repo: '/Users/dev/app',
  createdFile: false,
}

test('a write is recorded once, a repeat changes nothing on disk, and "the app created it" is never forgotten', async () => {
  const { ledger, file } = await ledgerAt('record')
  await ledger.record([{ ...hook, createdFile: true }])
  const first = await readFile(file, 'utf8')
  await ledger.record([{ ...hook, createdFile: true }])
  assert.equal(await readFile(file, 'utf8'), first, 'the same write again is not a disk write')
  await ledger.record([{ ...hook, createdFile: false }])
  const [entry] = await ledger.list()
  assert.equal(entry.createdFile, true, 'a later write over the file the app made does not unmake that')
  assert.equal(entry.source, 'write')
  assert.equal((await ledger.list()).length, 1)
})

test('a scan never demotes what a write recorded, and forgetting takes out exactly the named entries', async () => {
  const { ledger } = await ledgerAt('scan')
  await ledger.record([hook])
  await ledger.record([
    { ...hook, source: 'scan' },
    { ...hook, marker: 'other', source: 'scan' },
  ])
  const entries = await ledger.list()
  assert.deepEqual(
    entries.map((entry) => [entry.marker, entry.source]),
    [
      ['toml-block', 'write'],
      ['other', 'scan'],
    ],
  )
  await ledger.forget([ledgerKey(entries[1])])
  assert.deepEqual(
    (await ledger.list()).map((entry) => entry.marker),
    ['toml-block'],
  )
  await ledger.forgetWhere((entry) => entry.kind === 'agent-state-hooks')
  assert.deepEqual(await ledger.list(), [])
})

test('the first-run scan is remembered', async () => {
  const { ledger } = await ledgerAt('scanned')
  assert.equal(await ledger.scannedAt(), null)
  await ledger.markScanned()
  assert.equal(await ledger.scannedAt(), '2026-09-25T12:00:00.000Z')
})

test("a distribution's entries are mirrored into it, and only its own", async () => {
  const mirrorDir = await mkdtemp(join(tmpdir(), 'sprintengine-ledger-mirror-'))
  const mirror = join(mirrorDir, '.sprintengine', 'integration-ledger.json')
  const { ledger } = await ledgerAt('mirror', mirror)
  await ledger.record([
    hook,
    { ...hook, hostId: 'wsl:Ubuntu', path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app\\.codex\\config.toml' },
  ])
  const mirrored = JSON.parse(await readFile(mirror, 'utf8')) as { entries: Array<{ hostId: string }> }
  assert.deepEqual(
    mirrored.entries.map((entry) => entry.hostId),
    ['wsl:Ubuntu'],
  )
})

test('a garbled ledger reads as empty rather than taking the app down', async () => {
  const { ledger, file } = await ledgerAt('garbled')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, '{ nope')
  assert.deepEqual(await ledger.list(), [])
  await ledger.record([hook])
  assert.equal((await ledger.list()).length, 1)
})

test('the process-wide recorder is silent until a ledger is installed', async () => {
  recordIntegrationWrite(hook)
  const { ledger } = await ledgerAt('global')
  installIntegrationLedger(ledger)
  recordIntegrationWrite(hook)
  await ledger.flush()
  assert.equal((await ledger.list()).length, 1)
})

test('the machine is read off the path', () => {
  assert.equal(hostIdForPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev'), 'wsl:Ubuntu-24.04')
  assert.equal(hostIdForPath('//wsl$/Debian/home/dev'), 'wsl:Debian')
  assert.equal(hostIdForPath('C:\\Users\\dev\\app'), 'local')
  assert.equal(hostIdForPath('/Users/dev/app'), 'local')
})
