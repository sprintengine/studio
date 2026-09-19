/**
 * The usage-data consent mirror. The interesting assertion is the first one:
 * absent reads as ON, the opposite of the background-mode mirror it is
 * otherwise a twin of, because absent is what every fresh profile's first boot
 * looks like.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTelemetryConsentStore } from './consent-store'
import { test } from 'vitest'

test('consent-store', async () => {
  const FILE_NAME = 'telemetry-consent.json'

  async function withUserData(body: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'multicode-telemetry-consent-'))
    try {
      await body(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async function main(): Promise<void> {
    // no file: on, so the first boot of a fresh profile is not the one boot we
    // silently discard
    await withUserData(async (dir) => {
      const store = createTelemetryConsentStore({ resolveUserDataDir: () => dir })
      assert.equal(store.isEnabled(), true)
    })

    // an opt-out persists and survives a fresh process (new store over the same dir)
    await withUserData(async (dir) => {
      const store = createTelemetryConsentStore({ resolveUserDataDir: () => dir })
      store.set(false)
      assert.equal(store.isEnabled(), false)

      const onDisk = JSON.parse(await readFile(join(dir, FILE_NAME), 'utf8')) as Record<string, unknown>
      assert.deepEqual(onDisk, { telemetryEnabled: false })

      const reopened = createTelemetryConsentStore({ resolveUserDataDir: () => dir })
      assert.equal(reopened.isEnabled(), false, 'an opt-out must outlive the process that made it')
    })

    // and it comes back
    await withUserData(async (dir) => {
      const store = createTelemetryConsentStore({ resolveUserDataDir: () => dir })
      store.set(false)
      store.set(true)
      assert.equal(store.isEnabled(), true)
      assert.equal(createTelemetryConsentStore({ resolveUserDataDir: () => dir }).isEnabled(), true)
    })

    // only an explicit stored `false` turns it off; corrupt and wrong-shaped
    // payloads read as on, matching the absent case
    for (const [payload, expected] of [
      ['{"telemetryEnabled":false}', false],
      ['{"telemetryEnabled":true}', true],
      ['{ not json', true],
      ['[]', true],
      ['{}', true],
      ['"false"', true],
      ['{"telemetryEnabled":"no"}', true],
      ['{"telemetryEnabled":0}', true],
    ] as const) {
      await withUserData(async (dir) => {
        await writeFile(join(dir, FILE_NAME), payload, 'utf8')
        const store = createTelemetryConsentStore({ resolveUserDataDir: () => dir })
        assert.equal(store.isEnabled(), expected, `payload ${payload} must read as ${expected}`)
      })
    }

    // an unchanged value never rewrites the file
    await withUserData(async (dir) => {
      let writes = 0
      await writeFile(join(dir, FILE_NAME), '{"telemetryEnabled":false}', 'utf8')
      const store = createTelemetryConsentStore({
        resolveUserDataDir: () => {
          writes += 1
          return dir
        },
      })
      store.set(false)
      // One resolve for the read inside `set`, none for a write that did not happen.
      assert.equal(writes, 1)
    })

    // an unwritable location warns and still applies in memory — losing this
    // write is the one case where a restart would send data the user declined
    await withUserData(async (dir) => {
      const diagnostics: string[] = []
      const store = createTelemetryConsentStore({
        resolveUserDataDir: () => join(dir, 'missing-parent', 'nested'),
        logDiagnostic: (input) => diagnostics.push(input.title),
      })
      store.set(false)
      assert.deepEqual(diagnostics, ['Usage-data setting not saved'])
      assert.equal(store.isEnabled(), false, 'the opt-out still applies for this session')
    })

    console.log('telemetry consent-store tests passed')
  }

  const suiteRun = main()

  await suiteRun
})
