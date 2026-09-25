import assert from 'node:assert/strict'

import type { CliVersionAdvisoriesResult } from '../../../../shared/electron-api'
import {
  createCliVersionAdvisorySlice,
  subscribeCliVersionAdvisoryChanges,
  type CliVersionAdvisorySliceState,
} from './cliVersionAdvisorySlice'
import { test } from 'vitest'

test('cliVersionAdvisorySlice', async () => {
  const behind: CliVersionAdvisoriesResult = {
    ok: true,
    checkedAt: '2026-09-04T12:00:00Z',
    advisories: {
      local: {
        codex: {
          cli: 'codex',
          hostId: 'local',
          status: 'behind_latest',
          currentVersion: '0.153.2',
          latestVersion: '0.153.3',
          updateCommand: { kind: 'brew', command: 'brew upgrade codex' },
          checkedAt: '2026-09-04T12:00:00Z',
        },
      },
      'wsl:Ubuntu': {
        codex: {
          cli: 'codex',
          hostId: 'wsl:Ubuntu',
          status: 'current',
          currentVersion: '0.153.3',
          latestVersion: '0.153.3',
          updateCommand: { kind: 'npm', command: 'npm install -g @openai/codex@latest' },
          checkedAt: '2026-09-04T12:00:00Z',
        },
      },
    },
  }

  async function main(): Promise<void> {
    const carrier: CliVersionAdvisorySliceState = {
      cliVersionAdvisories: {},
      cliVersionAdvisoriesCheckedAt: null,
      cliVersionAdvisoriesError: null,
    }
    const inputs: unknown[] = []
    const slice = createCliVersionAdvisorySlice((mutator) => mutator(carrier), {
      getApi: () => ({
        cliVersionAdvisories: async (input) => {
          inputs.push(input)
          return behind
        },
      }),
    })
    const result = await slice.refreshCliVersionAdvisories({ force: true, detect: true })
    assert.equal(result?.ok, true)
    assert.deepEqual(inputs, [{ force: true, detect: true }], 'a Re-check asks main to detect again')
    await slice.refreshCliVersionAdvisories()
    assert.deepEqual(inputs[1], {}, 'a plain read asks for no detection')
    assert.equal(carrier.cliVersionAdvisories.local?.codex?.status, 'behind_latest')
    assert.equal(carrier.cliVersionAdvisories['wsl:Ubuntu']?.codex?.status, 'current', 'each machine keeps its own')
    assert.equal(carrier.cliVersionAdvisoriesCheckedAt, '2026-09-04T12:00:00Z')

    // A failure keeps the last advisories and records the message.
    slice.applyCliVersionAdvisories({ ok: false, message: 'npm did not answer' })
    assert.equal(carrier.cliVersionAdvisories.local?.codex?.status, 'behind_latest')
    assert.equal(carrier.cliVersionAdvisoriesError, 'npm did not answer')

    // A later good answer clears the error.
    slice.applyCliVersionAdvisories({ ok: true, checkedAt: '2026-09-04T13:00:00Z', advisories: {} })
    assert.deepEqual(carrier.cliVersionAdvisories, {})
    assert.equal(carrier.cliVersionAdvisoriesError, null)

    // Push subscription.
    let pushed: ((result: CliVersionAdvisoriesResult) => void) | null = null
    const unsubscribe = subscribeCliVersionAdvisoryChanges(slice.applyCliVersionAdvisories, {
      onCliVersionAdvisoriesChanged: (cb) => {
        pushed = cb
        return () => {
          pushed = null
        }
      },
    })
    pushed!(behind)
    assert.equal(carrier.cliVersionAdvisories.local?.codex?.latestVersion, '0.153.3')
    unsubscribe()
    assert.equal(pushed, null)

    const bare = createCliVersionAdvisorySlice((mutator) => mutator(carrier), { getApi: () => null })
    assert.equal(await bare.refreshCliVersionAdvisories(), null)

    console.log('cliVersionAdvisorySlice: ok')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
